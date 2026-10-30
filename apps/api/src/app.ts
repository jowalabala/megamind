// The public API: remote MCP for agents, plus REST equivalents for the bridge and scripts.
// Every route except /healthz needs an agent key; the tenant always comes from that key.
import { createHash } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import { historyRepo, type AuthenticatedAgent, type MasterMindDb } from "@mm/db";
import {
  acceptActions,
  acceptOutcome,
  acceptTask,
  actionBatchInput,
  IngestForbiddenError,
  logTaskInput,
  reportOutcomeInput,
  type AcceptDeps,
  type AcceptResult,
  type IngestSource,
} from "@mm/ingest";
import {
  registerCaptureTools,
  registerHistoryTools,
  searchHistoryInput,
  SERVER_INFO,
  SERVER_INSTRUCTIONS,
  ToolUserError,
  type CaptureResult,
  type SearchHistoryInput,
  type SearchHistoryResult,
} from "@mm/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

export interface AppDeps extends AcceptDeps {
  db: MasterMindDb;
  logger?: boolean | object;
  /** Requests per minute per agent key (or per IP without one). */
  rateLimitPerMinute?: number;
}

declare module "fastify" {
  interface FastifyRequest {
    agent?: AuthenticatedAgent;
  }
}

const toCapture = (r: AcceptResult): CaptureResult =>
  r.captured ? { captured: true, id: r.id } : { captured: false, reason: r.reason };

/** The local bridge identifies itself; everything else counts as remote MCP. */
const sourceOf = (req: FastifyRequest): IngestSource =>
  /^mm-bridge\//.test(String(req.headers["x-mm-client"] ?? "")) ? "bridge" : "mcp";

async function searchHistory(
  db: MasterMindDb,
  agent: AuthenticatedAgent,
  input: SearchHistoryInput,
): Promise<SearchHistoryResult> {
  if (!agent.scopes.includes("history:read")) {
    throw new IngestForbiddenError("This agent key does not have the history:read scope.");
  }
  if (!input.query && !input.resource) {
    throw Object.assign(new Error("Give a query, a resource, or both."), { statusCode: 400 });
  }
  const items = await db.withTenant(agent.tenantId, (tx) =>
    historyRepo.searchHistory(tx, {
      requesterMemberId: agent.memberId,
      text: input.query,
      resource: input.resource,
      kinds: input.kinds,
      since: input.since ? new Date(input.since) : undefined,
      before: input.before ? new Date(input.before) : undefined,
      limit: input.limit,
    }),
  );
  return {
    items: items.map(({ taskId, ...rest }) => ({ ...rest, task_id: taskId })),
  };
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({
    logger: deps.logger ?? false,
    // Agent payloads are capped well below this by the input schemas.
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(rateLimit, {
    max: deps.rateLimitPerMinute ?? 600,
    timeWindow: "1 minute",
    // Keyed by a hash of the credential, so a key is never kept in memory as a map key.
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      return auth ? createHash("sha256").update(auth).digest("hex") : req.ip;
    },
  });

  async function requireAgent(req: FastifyRequest, reply: FastifyReply) {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const agent = match ? await deps.db.system.authenticateAgent(match[1]!) : null;
    if (!agent) {
      return reply
        .code(401)
        .header("www-authenticate", 'Bearer realm="master-mind"')
        .send({ error: "unauthorized", message: "A valid Master Mind agent key is required." });
    }
    req.agent = agent;
  }

  app.setErrorHandler((error, req, reply) => {
    const err = error as Error & { statusCode?: number };
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: "invalid_input", issues: err.issues });
    }
    if (err instanceof IngestForbiddenError) {
      return reply.code(403).send({ error: "forbidden", message: err.message });
    }
    const status = err.statusCode;
    if (status && status < 500) return reply.code(status).send({ error: err.message });
    req.log.error({ err }, "request failed");
    return reply.code(500).send({ error: "internal_error" });
  });

  app.get("/healthz", async (_req, reply) => {
    const health = await deps.db.health();
    if (health.leakedTenantContext) return reply.code(500).send({ ok: false });
    return { ok: true };
  });

  // Remote MCP, stateless: one server per request, scoped to the calling agent.
  app.post("/mcp", { preHandler: requireAgent }, async (req, reply) => {
    const agent = req.agent!;
    const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
    const forbidden = (fn: () => Promise<AcceptResult>) =>
      fn().then(toCapture, (err) => {
        if (err instanceof IngestForbiddenError) throw new ToolUserError(err.message);
        throw err;
      });
    registerCaptureTools(server, {
      logTask: (input) => forbidden(() => acceptTask(deps, agent, input, sourceOf(req))),
      reportOutcome: (input) => forbidden(() => acceptOutcome(deps, agent, input, sourceOf(req))),
    });
    registerHistoryTools(server, {
      searchHistory: (input) =>
        searchHistory(deps.db, agent, input).catch((err) => {
          if (err instanceof IngestForbiddenError) throw new ToolUserError(err.message);
          throw err;
        }),
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  const methodNotAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header("allow", "POST").send({ error: "method_not_allowed" });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  // REST equivalents. Same validation, same pipeline.
  app.post("/v1/tasks", { preHandler: requireAgent }, async (req, reply) => {
    const result = await acceptTask(deps, req.agent!, logTaskInput.parse(req.body), sourceOf(req));
    return reply.code(result.captured ? 202 : 200).send(result);
  });
  app.post("/v1/outcomes", { preHandler: requireAgent }, async (req, reply) => {
    const input = reportOutcomeInput.parse(req.body);
    const result = await acceptOutcome(deps, req.agent!, input, sourceOf(req));
    return reply.code(result.captured ? 202 : 200).send(result);
  });
  app.post("/v1/actions", { preHandler: requireAgent }, async (req, reply) => {
    const input = actionBatchInput.parse(req.body);
    const result = await acceptActions(deps, req.agent!, input, sourceOf(req));
    return reply.code(result.captured ? 202 : 200).send(result);
  });
  app.post("/v1/history/search", { preHandler: requireAgent }, async (req) =>
    searchHistory(deps.db, req.agent!, searchHistoryInput.parse(req.body)),
  );
  // Lets the bridge check a key at login. Ids and scopes only.
  app.get("/v1/whoami", { preHandler: requireAgent }, async (req) => ({
    agent_id: req.agent!.agentId,
    scopes: req.agent!.scopes,
    capture_opt_out: req.agent!.captureOptOut,
  }));

  return app;
}
