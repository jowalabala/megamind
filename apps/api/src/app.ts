// The public API: remote MCP for agents, plus REST equivalents for the bridge and scripts.
// Every route except /healthz needs an agent key; the tenant always comes from that key.
import { createHash } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import { appendAuditEvent } from "@mm/audit";
import { alertsFor, describeAlert } from "@mm/awareness";
import {
  agentSessions,
  and,
  connectionRepo,
  eq,
  historyRepo,
  presenceRepo,
  type AuthenticatedAgent,
  type MasterMindDb,
} from "@mm/db";
import type { QueueName } from "@mm/db/queue";
import { signGatewayToken } from "@mm/realtime";
import { backfillAddedRepos, installationOf, planWebhook, verifySignature } from "@mm/github";
import {
  acceptActions,
  acceptIntent,
  acceptOutcome,
  acceptTask,
  actionBatchInput,
  announceIntentInput,
  idFromKey,
  IngestForbiddenError,
  logTaskInput,
  reportOutcomeInput,
  recordSkillUseInput,
  type AcceptDeps,
  type AcceptResult,
  type IngestSource,
  type RedactorFor,
} from "@mm/ingest";
import { CollabError } from "@mm/collab";
import { channelHandlers, STATUS } from "./channels.ts";
import { skillHandlers } from "./skills.ts";
import { handleInteraction, parseInteraction, respond, verifySlackRequest } from "@mm/slack";
import {
  ChannelToolError,
  channelInputs,
  registerAwarenessTools,
  registerCaptureTools,
  registerChannelTools,
  registerHistoryTools,
  registerSkillTools,
  getSkillInput,
  searchHistoryInput,
  searchSkillsInput,
  SkillToolError,
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
  /** Shared with the gateway; signs short-lived WebSocket tokens. */
  gatewaySecret?: string;
  /** Public URL of the gateway, e.g. wss://app.example.com (the bridge connects to <url>/ws). */
  gatewayUrl?: string;
  /** Redacts channel text (deterministic layers). Without it channels are unavailable. */
  redactorFor?: RedactorFor;
  /** The web app's URL, for approval links. */
  webUrl?: string;
  /** Slack app signing secret. Without it the Slack interactions endpoint is not mounted. */
  slackSigningSecret?: string;
  /** Where Slack's response_url may point (tests use a local fake). */
  slackResponseOrigins?: string[];
  /** GitHub App webhook secret. Without it the webhook endpoint is not mounted. */
  githubWebhookSecret?: string;
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

function requireScope(agent: AuthenticatedAgent, scope: AuthenticatedAgent["scopes"][number]) {
  if (!agent.scopes.includes(scope)) {
    throw new IngestForbiddenError(`This agent key does not have the ${scope} scope.`);
  }
}

async function whatsHappening(db: MasterMindDb, agent: AuthenticatedAgent) {
  requireScope(agent, "collab");
  const sessions = await db.withTenant(agent.tenantId, (tx) =>
    presenceRepo.liveSessions(tx, agent.memberId),
  );
  return { sessions };
}

/** Overlaps for one of the agent's sessions (by its client id), or all its live ones. */
async function checkOverlaps(
  db: MasterMindDb,
  agent: AuthenticatedAgent,
  clientSessionId?: string,
) {
  requireScope(agent, "collab");
  return db.withTenant(agent.tenantId, async (tx) => {
    const sessions = await tx
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.agentIdentityId, agent.agentId),
          eq(agentSessions.status, "active"),
          ...(clientSessionId ? [eq(agentSessions.clientSessionId, clientSessionId)] : []),
        ),
      );
    const overlaps = [];
    for (const s of sessions) {
      for (const a of await alertsFor(tx, s.id, agent.memberId))
        overlaps.push({ ...a, text: describeAlert(a) });
    }
    return { overlaps };
  });
}

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
    if (err instanceof CollabError) {
      return reply
        .code(STATUS[err.code])
        .send({ error: err.code, message: err.message, ...err.detail });
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
    const userError = (err: unknown) => {
      if (err instanceof IngestForbiddenError) throw new ToolUserError(err.message);
      throw err;
    };
    registerAwarenessTools(server, {
      whatsHappening: () => whatsHappening(deps.db, agent).catch(userError),
      announceIntent: (input) =>
        forbidden(async () => {
          requireScope(agent, "collab");
          return acceptIntent(deps, agent, input, sourceOf(req));
        }),
      checkOverlaps: (input) => checkOverlaps(deps.db, agent, input.session_id).catch(userError),
    });
    if (deps.redactorFor) {
      const ch = channelHandlers(
        { db: deps.db, redactorFor: deps.redactorFor, webUrl: deps.webUrl },
        agent,
      );
      const wrap =
        <A>(fn: (a: A) => Promise<unknown>) =>
        (a: A) =>
          fn(a).catch((err) => {
            if (err instanceof CollabError) throw new ChannelToolError(err.message);
            throw err;
          });
      registerChannelTools(server, {
        request: wrap(ch.request),
        send: wrap(ch.send),
        read: wrap(ch.read),
        claim: wrap(ch.claim),
        release: wrap(ch.release),
        propose: wrap(ch.propose),
        accept: wrap(ch.accept),
        close: wrap(ch.close),
      });
    }
    registerHistoryTools(server, {
      searchHistory: (input) =>
        searchHistory(deps.db, agent, input).catch((err) => {
          if (err instanceof IngestForbiddenError) throw new ToolUserError(err.message);
          throw err;
        }),
    });
    const sk = skillHandlers(deps.db, agent, sourceOf(req));
    const skillError = (err: unknown): never => {
      if (err instanceof IngestForbiddenError) throw new SkillToolError(err.message);
      throw err;
    };
    registerSkillTools(server, {
      search: (input) => sk.search(input).catch(skillError),
      get: (input) => sk.get(input).catch(skillError),
      recordUse: (input) => sk.recordUse(input).catch(skillError),
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
  app.get("/v1/presence", { preHandler: requireAgent }, async (req) =>
    whatsHappening(deps.db, req.agent!),
  );
  app.post("/v1/intents", { preHandler: requireAgent }, async (req, reply) => {
    requireScope(req.agent!, "collab");
    const result = await acceptIntent(
      deps,
      req.agent!,
      announceIntentInput.parse(req.body),
      sourceOf(req),
    );
    return reply.code(result.captured ? 202 : 200).send(result);
  });
  app.get("/v1/overlaps", { preHandler: requireAgent }, async (req) => {
    const q = req.query as { session_id?: string };
    return checkOverlaps(
      deps.db,
      req.agent!,
      typeof q.session_id === "string" ? q.session_id : undefined,
    );
  });
  // A 5-minute token for the real-time gateway, so agent keys never go to the WebSocket.
  app.post("/v1/gateway/token", { preHandler: requireAgent }, async (req, reply) => {
    const agent = req.agent!;
    requireScope(agent, "collab");
    if (!deps.gatewaySecret || !deps.gatewayUrl) {
      return reply.code(503).send({ error: "gateway_not_configured" });
    }
    if (agent.captureOptOut) return reply.code(403).send({ error: "capture_opt_out" });
    const { token, expiresAt } = signGatewayToken(deps.gatewaySecret, {
      tenantId: agent.tenantId,
      agentId: agent.agentId,
      memberId: agent.memberId,
    });
    return { token, expires_at: expiresAt.toISOString(), gateway_url: deps.gatewayUrl };
  });
  // Channels. People approve them in the web app; agent keys never can.
  const refuseAgents = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(403).send({
      error: "forbidden",
      message: "Channels are approved by a person in Master Mind, never by an agent.",
    });
  app.post("/v1/channels/:id/approve", { preHandler: requireAgent }, refuseAgents);
  app.post("/v1/channels/:id/decline", { preHandler: requireAgent }, refuseAgents);
  if (deps.redactorFor) {
    const ch = (req: FastifyRequest) =>
      channelHandlers(
        { db: deps.db, redactorFor: deps.redactorFor!, webUrl: deps.webUrl },
        req.agent!,
      );
    const id = (req: FastifyRequest) => (req.params as { id: string }).id;
    const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;
    app.post("/v1/channels", { preHandler: requireAgent }, async (req, reply) =>
      reply.code(201).send(await ch(req).request(channelInputs.request.parse(req.body))),
    );
    app.get("/v1/channels/:id", { preHandler: requireAgent }, async (req) => {
      const q = req.query as Record<string, string>;
      return ch(req).read(
        channelInputs.read.parse({
          channel_id: id(req),
          session_id: q.session_id,
          after_seq: q.after_seq ? Number(q.after_seq) : 0,
        }),
      );
    });
    app.post("/v1/channels/:id/messages", { preHandler: requireAgent }, async (req, reply) => {
      const out = (await ch(req).send(
        channelInputs.send.parse({ ...body(req), channel_id: id(req) }),
      )) as { status: string };
      return reply.code(out.status === "blocked" ? 422 : 201).send(out);
    });
    app.post("/v1/channels/:id/claims", { preHandler: requireAgent }, async (req) =>
      ch(req).claim(channelInputs.claim.parse({ ...body(req), channel_id: id(req) })),
    );
    app.post("/v1/channels/:id/releases", { preHandler: requireAgent }, async (req) =>
      ch(req).release(channelInputs.release.parse({ ...body(req), channel_id: id(req) })),
    );
    app.post("/v1/channels/:id/agreements", { preHandler: requireAgent }, async (req) =>
      ch(req).propose(channelInputs.propose.parse({ ...body(req), channel_id: id(req) })),
    );
    app.post(
      "/v1/channels/:id/agreements/:version/accept",
      { preHandler: requireAgent },
      async (req) =>
        ch(req).accept(
          channelInputs.accept.parse({
            ...body(req),
            channel_id: id(req),
            version: Number((req.params as { version: string }).version),
          }),
        ),
    );
    app.post("/v1/channels/:id/close", { preHandler: requireAgent }, async (req) =>
      ch(req).close(channelInputs.close.parse({ ...body(req), channel_id: id(req) })),
    );
  }
  // Skills: approved versions only.
  const skills = (req: FastifyRequest) => skillHandlers(deps.db, req.agent!, sourceOf(req));
  app.get("/v1/skills", { preHandler: requireAgent }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return skills(req).search(
      searchSkillsInput.parse({
        query: q.q,
        category: q.category,
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    );
  });
  // Before /v1/skills/:id, so "subscribed" isn't read as an id.
  app.get("/v1/skills/subscribed", { preHandler: requireAgent }, async (req) =>
    skills(req).subscribed(),
  );
  app.get("/v1/skills/:id", { preHandler: requireAgent }, async (req) =>
    skills(req).get(getSkillInput.parse({ skill_id: (req.params as { id: string }).id })),
  );
  app.post("/v1/skills/:id/uses", { preHandler: requireAgent }, async (req, reply) => {
    const input = recordSkillUseInput.parse({
      ...(req.body as object),
      skill_id: (req.params as { id: string }).id,
    });
    const out = await skills(req).recordUse(input);
    return reply.code(out.recorded ? 201 : 200).send(out);
  });

  // Lets the bridge check a key at login. Ids and scopes only.
  app.get("/v1/whoami", { preHandler: requireAgent }, async (req) => ({
    agent_id: req.agent!.agentId,
    scopes: req.agent!.scopes,
    capture_opt_out: req.agent!.captureOptOut,
  }));

  if (deps.slackSigningSecret) {
    const secret = deps.slackSigningSecret;
    // Button clicks from Slack. The signature covers the raw form body, so keep it.
    await app.register(async (scope) => {
      scope.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_req, body, done) => done(null, body),
      );
      scope.post(
        "/webhooks/slack/interactions",
        { config: { rateLimit: { max: 6000, timeWindow: "1 minute" } } },
        async (req, reply) => {
          const body = typeof req.body === "string" ? req.body : "";
          const ok = verifySlackRequest(
            secret,
            {
              timestamp: String(req.headers["x-slack-request-timestamp"] ?? ""),
              signature: String(req.headers["x-slack-signature"] ?? ""),
            },
            body,
          );
          if (!ok) return reply.code(401).send({ error: "bad_signature" });
          const payload = parseInteraction(body);
          if (!payload) return reply.code(400).send({ error: "invalid_payload" });
          const result = await handleInteraction({ db: deps.db }, payload);
          if (result) {
            // Slack wants an answer within 3 seconds; the message update can follow.
            void respond(result, deps.slackResponseOrigins).catch((err) =>
              req.log.warn({ err: (err as Error).message }, "slack response failed"),
            );
          }
          return reply.code(200).send();
        },
      );
    });
  }

  if (deps.githubWebhookSecret) {
    const secret = deps.githubWebhookSecret;
    // Its own scope: the signature is over the exact bytes, so this route keeps the raw body.
    await app.register(async (scope) => {
      scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) =>
        done(null, body),
      );
      scope.post(
        "/webhooks/github",
        // GitHub sends from a few addresses; the per-IP agent limit would throttle it.
        { config: { rateLimit: { max: 6000, timeWindow: "1 minute" } } },
        async (req, reply) => {
          const body = req.body as Buffer;
          const sig = req.headers["x-hub-signature-256"];
          if (
            !Buffer.isBuffer(body) ||
            !verifySignature(secret, body, typeof sig === "string" ? sig : undefined)
          ) {
            return reply.code(401).send({ error: "bad_signature" });
          }
          const event = String(req.headers["x-github-event"] ?? "");
          const delivery = String(req.headers["x-github-delivery"] ?? "");
          let payload: unknown;
          try {
            payload = JSON.parse(body.toString("utf8"));
          } catch {
            return reply.code(400).send({ error: "invalid_json" });
          }
          if (event === "ping") return reply.code(200).send({ ok: true });

          const installationId = installationOf(payload);
          const conn = installationId
            ? await deps.db.system.resolveConnection("github", installationId)
            : null;
          // Installations that never finished setup here (or were removed) are ignored.
          if (!conn || !installationId)
            return reply.code(202).send({ ignored: "unknown_installation" });

          const plan = planWebhook(event, payload);
          if (plan.kind === "ignore") return reply.code(202).send({ ignored: plan.reason });
          if (conn.status === "removed" && plan.kind !== "installation_status") {
            return reply.code(202).send({ ignored: "installation_removed" });
          }
          const target = {
            tenantId: conn.tenantId,
            connectionId: conn.connectionId,
            installationId,
          };

          if (plan.kind === "sync_prs") {
            for (const [i, pr] of plan.prs.entries()) {
              await deps.queue.send(
                "github.sync_pr",
                { ...target, repoId: pr.repoId, fullName: pr.fullName, number: pr.number },
                { id: idFromKey(["github", delivery || crypto.randomUUID(), String(i)]) },
              );
            }
          } else if (plan.kind === "installation_status") {
            await deps.db.withTenant(conn.tenantId, async (tx) => {
              await connectionRepo.setConnectionStatus(tx, conn.connectionId, plan.status);
              await appendAuditEvent(tx, conn.tenantId, {
                actorType: "system",
                actorId: null,
                action: "connection.status_changed",
                targetType: "connection",
                targetId: conn.connectionId,
                payload: { provider: "github", status: plan.status },
              });
            });
          } else {
            await backfillAddedRepos(
              {
                db: deps.db,
                enqueue: async (name, data, options) => {
                  await deps.queue.send(name as QueueName, data, options);
                },
              },
              target,
              plan.repos,
            );
          }
          return reply.code(202).send({ accepted: plan.kind });
        },
      );
    });
  }

  return app;
}
