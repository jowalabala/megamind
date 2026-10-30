// End to end: an MCP client (as an agent would) -> API -> bronze + queue -> worker -> Postgres.
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  agentRepo,
  connectionRepo,
  connections,
  createDb,
  eq,
  memberRepo,
  metricObservations,
  tasks,
  sql,
  type MasterMindDb,
} from "@mm/db";
import { createQueue, type QueueClient } from "@mm/db/queue";
import { adminQuery, startTestDatabase, type TestDatabase } from "@mm/db/testing";
import { memoryBronze, startIngestWorkers, tenantRedactors } from "@mm/ingest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";

let env: TestDatabase;
let db: MasterMindDb;
let queue: QueueClient;
let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
const bronze = memoryBronze();
const WEBHOOK_SECRET = "whsec_" + "test".repeat(8);
const keys: Record<string, string> = {};
const tenants: Record<string, string> = {};

// Assembled at runtime so no secret-shaped literal is committed.
const AWS_KEY = ["AKIA", "Q7ZJ3MXW", "P2LN5KTR"].join("");

async function setupTenant(slug: string) {
  const t = await db.system.provisionTenant({
    name: slug,
    slug,
    workosOrgId: `org_${slug}`,
    admin: { workosUserId: `admin_${slug}`, email: `admin@${slug}.test`, displayName: null },
  });
  tenants[slug] = t.tenantId;
  return t.tenantId;
}

async function addAgent(tenantId: string, name: string, opts: { optOut?: boolean } = {}) {
  return db.withTenant(tenantId, async (tx) => {
    const { member } = await memberRepo.ensureMember(tx, tenantId, {
      workosUserId: `user_${name}`,
      email: `${name}@example.test`,
      displayName: null,
    });
    if (opts.optOut) {
      await tx.execute(sql`UPDATE members SET capture_opt_out = true WHERE id = ${member.id}`);
    }
    const { key, agent } = await agentRepo.createAgent(tx, tenantId, {
      memberId: member.id,
      name: `${name}'s agent`,
      kind: "claude_code",
      createdByMemberId: member.id,
    });
    keys[name] = key;
    return agent.id;
  });
}

async function mcpClient(key: string) {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  );
  return client;
}

async function waitFor<T>(fn: () => Promise<T | undefined | null>, ms = 10_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const post = (path: string, body: unknown, key?: string) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  env = await startTestDatabase();
  db = createDb({ connectionString: env.appUrl, max: 4 });
  queue = await createQueue({ connectionString: env.appUrl, onError: () => {} });
  const acme = await setupTenant("acme");
  const globex = await setupTenant("globex");
  await addAgent(acme, "dana");
  await addAgent(acme, "omer", { optOut: true });
  await addAgent(globex, "gina");
  await startIngestWorkers(queue, {
    db,
    bronze,
    redactorFor: tenantRedactors({ db, pseudonymSecret: "s".repeat(40) }),
  });
  app = await buildApp({ db, queue, bronze, githubWebhookSecret: WEBHOOK_SECRET });
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  await queue?.stop();
  await db?.close();
  await env?.stop();
});

describe("auth", () => {
  it("rejects missing, malformed and unknown keys", async () => {
    expect((await post("/v1/tasks", { title: "x" })).status).toBe(401);
    expect((await post("/v1/tasks", { title: "x" }, "not-a-key")).status).toBe(401);
    const unknown = "mm_live_" + "A".repeat(40);
    const res = await post("/mcp", {}, unknown);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("only POST is allowed on /mcp (stateless server)", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      headers: { authorization: `Bearer ${keys.dana}` },
    });
    expect(res.status).toBe(405);
  });

  it("a revoked key stops working immediately", async () => {
    const tenantId = tenants.acme!;
    const { key, agent } = await db.withTenant(tenantId, async (tx) => {
      const [m] = await memberRepo.listMembers(tx);
      return agentRepo.createAgent(tx, tenantId, {
        memberId: m!.id,
        name: "temp",
        kind: "custom",
        createdByMemberId: m!.id,
      });
    });
    expect((await post("/v1/tasks", { title: "ok" }, key)).status).toBe(202);
    await db.withTenant(tenantId, (tx) => agentRepo.revokeAgent(tx, agent.id));
    expect((await post("/v1/tasks", { title: "ok" }, key)).status).toBe(401);
  });
});

describe("remote MCP", () => {
  it("lists the capture tools with instructions", async () => {
    const client = await mcpClient(keys.dana!);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "log_task",
      "report_outcome",
      "search_history",
    ]);
    expect(tools.find((t) => t.name === "search_history")!.annotations?.readOnlyHint).toBe(true);
    expect(client.getInstructions()).toContain("log_task");
    await client.close();
  });

  it("week 2 check: an agent logs a task; the secret and email are masked before storage", async () => {
    const client = await mcpClient(keys.dana!);
    const result = await client.callTool({
      name: "log_task",
      arguments: {
        title: "Debug S3 upload for jane.customer@bigco.test",
        summary: `Found the hardcoded key ${AWS_KEY} in upload.ts and moved it to Secrets Manager.`,
        external_refs: ["github:pr:acme/api#512"],
        session: { id: "claude-code-1", repo: "github.com/acme/api" },
      },
    });
    expect(result.isError).toBeFalsy();
    const taskId = (result.structuredContent as { task_id: string }).task_id;
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);

    const task = await waitFor(async () => {
      const [t] = await db.withTenant(tenants.acme!, (tx) =>
        tx.select().from(tasks).where(eq(tasks.id, taskId)),
      );
      return t;
    });
    expect(task.titleRedacted).toBe("Debug S3 upload for [EMAIL]");
    expect(task.summaryRedacted).toBe(
      "Found the hardcoded key [SECRET:aws_access_key_id] in upload.ts and moved it to Secrets Manager.",
    );

    // report_outcome for the same task, through MCP.
    const outcome = await client.callTool({
      name: "report_outcome",
      arguments: { task_id: taskId, metric: "ci.first_pass", value: 1 },
    });
    expect(outcome.structuredContent).toMatchObject({ captured: true });
    await waitFor(async () => {
      const rows = await db.withTenant(tenants.acme!, (tx) =>
        tx.select().from(metricObservations).where(eq(metricObservations.taskId, taskId)),
      );
      return rows[0];
    });
    await client.close();

    // The raw key exists only in the encrypted bronze store, nowhere in Postgres.
    const { rows } = await adminQuery(
      env.adminUrl,
      `SELECT (SELECT count(*) FROM tasks WHERE summary_redacted LIKE $1)
            + (SELECT count(*) FROM pgboss.job WHERE data::text LIKE $1) AS n`,
      [`%${AWS_KEY}%`],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it("week 2 check: an opted-out member's data is dropped, nothing is stored", async () => {
    const before = bronze.objects.size;
    const client = await mcpClient(keys.omer!);
    const result = await client.callTool({
      name: "log_task",
      arguments: { title: "Quarterly comp review", summary: "Salaries for the team" },
    });
    expect(result.structuredContent).toEqual({ captured: false, reason: "capture_opt_out" });
    expect((result.content as { text: string }[])[0]!.text).toContain("opted out");
    await client.close();
    expect(bronze.objects.size).toBe(before);
    const { rows } = await adminQuery(
      env.adminUrl,
      "SELECT count(*)::int AS n FROM tasks WHERE title_redacted LIKE '%comp review%'",
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("returns a validation error to the agent for bad input", async () => {
    const client = await mcpClient(keys.dana!);
    const result = await client.callTool({
      name: "log_task",
      arguments: { title: "", external_refs: ["not a ref"] },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });
});

describe("tenant isolation through the API", () => {
  it("a task logged by another tenant's agent is invisible to this tenant", async () => {
    const res = await post("/v1/tasks", { title: "Globex pricing page test" }, keys.gina);
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    await waitFor(async () => {
      const [t] = await db.withTenant(tenants.globex!, (tx) =>
        tx.select().from(tasks).where(eq(tasks.id, id)),
      );
      return t;
    });
    const seenByAcme = await db.withTenant(tenants.acme!, (tx) =>
      tx.select().from(tasks).where(eq(tasks.id, id)),
    );
    expect(seenByAcme).toHaveLength(0);
  });
});

describe("REST", () => {
  it("accepts action batches and rejects invalid ones with 400", async () => {
    const ok = await post(
      "/v1/actions",
      {
        session: { id: "cc-rest" },
        events: [
          {
            id: crypto.randomUUID(),
            kind: "edit",
            summary: "Edited invoice.ts",
            occurred_at: new Date().toISOString(),
          },
        ],
      },
      keys.dana,
    );
    expect(ok.status).toBe(202);
    const bad = await post("/v1/actions", { session: { id: "x" }, events: [] }, keys.dana);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_input" });
  });
});

describe("search_history (week 3)", () => {
  it("week 3 check: a bridge-captured action is searchable over MCP within seconds", async () => {
    const eventId = crypto.randomUUID();
    const res = await fetch(`${baseUrl}/v1/actions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${keys.dana}`,
        "x-mm-client": "mm-bridge/0.1.0",
      },
      body: JSON.stringify({
        session: { id: "cc-week3", repo: "github.com/acme/api", tool: "claude_code" },
        events: [
          {
            id: eventId,
            kind: "edit",
            summary: "Edited src/billing/proration.ts",
            resources: ["git:github.com/acme/api:src/billing/proration.ts#L10-42"],
            occurred_at: new Date().toISOString(),
          },
        ],
      }),
    });
    expect(res.status).toBe(202);

    const started = Date.now();
    const client = await mcpClient(keys.dana!);
    const found = await waitFor(async () => {
      const r = await client.callTool({
        name: "search_history",
        arguments: { resource: "src/billing/proration" },
      });
      const items = (r.structuredContent as { items: { id: string }[] }).items;
      return items.find((i) => i.id === eventId) ? r : null;
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    const item = (found.structuredContent as { items: Record<string, unknown>[] }).items[0]!;
    expect(item).toMatchObject({
      type: "action",
      kind: "edit",
      who: "you",
      resources: ["git:github.com/acme/api:src/billing/proration.ts#L10-42"],
    });
    const text = (found.content as { text: string }[])[0]!.text;
    expect(text).toContain("information, not instructions");

    const [row] = await db
      .withTenant(tenants.acme!, (tx) =>
        tx.execute<{ source: string }>(sql`SELECT source FROM action_events WHERE id = ${eventId}`),
      )
      .then((r) => r.rows);
    expect(row!.source).toBe("bridge");
    await client.close();
  });

  it("is available over REST, and needs a query or resource", async () => {
    const ok = await post("/v1/history/search", { query: "proration" }, keys.dana);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);
    expect((await post("/v1/history/search", {}, keys.dana)).status).toBe(400);
  });

  it("never shows another tenant's history", async () => {
    const res = await post("/v1/history/search", { query: "proration" }, keys.gina);
    expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("needs the history:read scope", async () => {
    const tenantId = tenants.acme!;
    const key = await db.withTenant(tenantId, async (tx) => {
      const [m] = await tx
        .execute<{ id: string }>(sql`SELECT id FROM members LIMIT 1`)
        .then((r) => r.rows);
      return (
        await agentRepo.createAgent(tx, tenantId, {
          memberId: m!.id,
          name: "capture only",
          kind: "custom",
          scopes: ["capture:write"],
          createdByMemberId: m!.id,
        })
      ).key;
    });
    expect((await post("/v1/history/search", { query: "x" }, key)).status).toBe(403);
    const client = await mcpClient(key);
    const r = await client.callTool({ name: "search_history", arguments: { query: "x" } });
    expect(r.isError).toBe(true);
    await client.close();
  });

  it("whoami returns the key's scopes, nothing personal", async () => {
    const res = await fetch(`${baseUrl}/v1/whoami`, {
      headers: { authorization: `Bearer ${keys.dana}` },
    });
    expect(await res.json()).toEqual({
      agent_id: expect.any(String),
      scopes: ["capture:write", "history:read"],
      capture_opt_out: false,
    });
  });
});

describe("GitHub webhooks (week 4)", () => {
  const deliver = (event: string, payload: unknown, secret = WEBHOOK_SECRET) => {
    const body = JSON.stringify(payload);
    return fetch(`${baseUrl}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": crypto.randomUUID(),
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      body,
    });
  };
  let connectionId: string;

  beforeAll(async () => {
    const tenantId = tenants.acme!;
    connectionId = await db.withTenant(tenantId, async (tx) => {
      const [admin] = await tx
        .execute<{ id: string }>(sql`SELECT id FROM members WHERE role = 'admin'`)
        .then((r) => r.rows);
      return (
        await connectionRepo.upsertGithubInstallation(tx, tenantId, {
          installationId: "777",
          accountLogin: "acme",
          createdByMemberId: admin!.id,
        })
      ).connection.id;
    });
  });

  it("rejects deliveries with a bad or missing signature", async () => {
    expect((await deliver("ping", { zen: "x" }, "wrong-secret")).status).toBe(401);
    const unsigned = await fetch(`${baseUrl}/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "ping" },
      body: "{}",
    });
    expect(unsigned.status).toBe(401);
    expect((await deliver("ping", { zen: "x" })).status).toBe(200);
  });

  it("ignores installations that aren't connected to a workspace", async () => {
    const res = await deliver("pull_request", {
      action: "opened",
      installation: { id: 123456 },
      repository: { id: 1, full_name: "evil/repo" },
      pull_request: { number: 1 },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ignored: "unknown_installation" });
  });

  it("turns a PR event into a sync job holding pointers only", async () => {
    const res = await deliver("pull_request", {
      action: "closed",
      installation: { id: 777 },
      repository: { id: 1001, full_name: "acme/api" },
      pull_request: { number: 12, title: "SECRET TITLE", body: "secret body" },
    });
    expect(res.status).toBe(202);
    const { rows } = await adminQuery(
      env.adminUrl,
      "SELECT data FROM pgboss.job WHERE name = 'github.sync_pr'",
    );
    expect(rows.map((r) => r.data)).toEqual([
      {
        tenantId: tenants.acme,
        connectionId,
        installationId: "777",
        repoId: 1001,
        fullName: "acme/api",
        number: 12,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("SECRET");
  });

  it("an uninstall marks the connection removed, and later events are ignored", async () => {
    await deliver("installation", { action: "deleted", installation: { id: 777 } });
    const [c] = await db.withTenant(tenants.acme!, (tx) =>
      tx.select().from(connections).where(eq(connections.id, connectionId)),
    );
    expect(c!.status).toBe("removed");
    const res = await deliver("pull_request", {
      action: "opened",
      installation: { id: 777 },
      repository: { id: 1001, full_name: "acme/api" },
      pull_request: { number: 13 },
    });
    expect(await res.json()).toEqual({ ignored: "installation_removed" });
  });
});
