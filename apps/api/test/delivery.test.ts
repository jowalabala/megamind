// Week 9 check (docs/PLAN.md §10): an approved v2 skill reaches an agent and a retired one
// disappears; a channel is approved from Slack; a HubSpot sequence is judged.
//
// Real: Postgres, queue and ingest worker, the API (MCP over HTTP, REST, Slack endpoint), the
// bridge's skill sync, the notification sender, the HubSpot connector, the judge. Fake: Slack's
// and HubSpot's HTTP APIs (one local server playing both, from their documented shapes).
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "@mm/bridge/api";
import { syncSkills } from "@mm/bridge/skills";
import {
  agentRepo,
  agentSessions,
  auditEvents,
  channelParticipants,
  channels,
  connectionRepo,
  createDb,
  eq,
  judgments,
  members,
  memberRepo,
  notifications,
  skillUsage,
  sql,
  taskAttributions,
  tasks,
  teams,
  type MasterMindDb,
  type TenantTx,
} from "@mm/db";
import { createQueue, type QueueClient } from "@mm/db/queue";
import { startTestDatabase, type TestDatabase } from "@mm/db/testing";
import {
  finalizeSequenceOutcomes,
  storeRefreshToken,
  syncHubspot,
  type HubspotDeps,
} from "@mm/hubspot";
import { memoryBronze, startIngestWorkers, tenantRedactors } from "@mm/ingest";
import { localLake, publishOutbox } from "@mm/lake";
import { attributeTasks, builtinPacks, categorizeTask, judgeSweep } from "@mm/packs";
import { reviewSkill, setSubscription } from "@mm/skills";
import { botTokenPurpose, sendNotifications, signSlackRequest } from "@mm/slack";
import { localVault } from "@mm/vault";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";

const PSEUDO = "p".repeat(40);
const SIGNING = "slack-signing-secret-for-tests";
const BOT_TOKEN = "test-bot-token";
const REFRESH = "hubspot-refresh-token";
const DAY = 86_400_000;
const vault = localVault("v".repeat(40));
let env: TestDatabase;
let db: MasterMindDb;
let queue: QueueClient;
let app: Awaited<ReturnType<typeof buildApp>>;
let fake: Server;
let api: string;
let fakeUrl: string;
let tenantId: string;
let adminId: string;
const who: Record<string, { memberId: string; agentId: string; key: string }> = {};

// --- The fake Slack and HubSpot -----------------------------------------------------------------

const slackUsers: Record<string, string> = {
  "dana@acme.test": "UDANA",
  "lior@acme.test": "ULIOR",
};
const posted: {
  channel: string;
  text: string;
  blocks: { type: string; elements?: { action_id?: string; value?: string }[] }[];
}[] = [];
const responses: { text: string }[] = [];
const NOW = new Date();
const T0 = NOW.getTime() - 160 * DAY;
/** 25 sequences, 4 days apart; replies out of 30 enrolled. The last one does far better. */
const SEQUENCES = Array.from({ length: 25 }, (_, i) => ({
  id: String(1001 + i),
  name: i === 19 ? "Outbound CFOs Q3" : `Outbound wave ${i + 1}`,
  createdAt: new Date(T0 + i * 4 * DAY),
  replied: i === 24 ? 20 : i === 23 ? 0 : 3 + (i % 7),
}));

async function body(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s;
}

function fakeServer(): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const text = await body(req);
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    const p = url.pathname;
    // Slack
    if (p.startsWith("/slack/")) {
      if (req.headers.authorization !== `Bearer ${BOT_TOKEN}`)
        return json(200, { ok: false, error: "invalid_auth" });
      const form = new URLSearchParams(text);
      if (p === "/slack/users.lookupByEmail") {
        const id = slackUsers[form.get("email") ?? ""];
        return json(200, id ? { ok: true, user: { id } } : { ok: false, error: "users_not_found" });
      }
      if (p === "/slack/chat.postMessage") {
        posted.push({
          channel: form.get("channel")!,
          text: form.get("text")!,
          blocks: JSON.parse(form.get("blocks") ?? "[]"),
        });
        return json(200, { ok: true, ts: "1.0" });
      }
    }
    if (p.startsWith("/respond/")) {
      responses.push(JSON.parse(text));
      return json(200, { ok: true });
    }
    // HubSpot
    if (p === "/hubspot/oauth/v1/token") {
      const form = new URLSearchParams(text);
      if (form.get("refresh_token") !== REFRESH) return json(400, { message: "bad token" });
      return json(200, { access_token: "hs-access", refresh_token: REFRESH, expires_in: 1800 });
    }
    if (req.headers.authorization !== "Bearer hs-access") return json(401, {});
    if (p === "/hubspot/crm/v3/owners") {
      return json(200, {
        results: [
          { id: "77", userId: 501, email: "Dana@acme.test" },
          { id: "78", userId: 502, email: "someone-else@acme.test" },
        ],
      });
    }
    const seq = /^\/hubspot\/automation\/v4\/sequences(?:\/(\d+))?$/.exec(p);
    if (seq) {
      const userId = Number(url.searchParams.get("userId"));
      const mine = userId === 501 ? SEQUENCES : [];
      const raw = (s: (typeof SEQUENCES)[number]) => ({
        id: s.id,
        name: s.name,
        userId: String(userId),
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.createdAt.toISOString(),
        steps: [
          { actionType: "SEND_EMAIL" },
          { actionType: "CREATE_TASK" },
          { actionType: "SEND_EMAIL" },
        ],
      });
      if (seq[1]) {
        const s = mine.find((x) => x.id === seq[1]);
        return s ? json(200, raw(s)) : json(404, {});
      }
      return json(200, { results: mine.map((s) => ({ id: s.id, name: s.name })) });
    }
    if (p === "/hubspot/crm/v3/objects/contacts/search") {
      const q = JSON.parse(text) as {
        filterGroups: { filters: { propertyName: string; value: string }[] }[];
        properties: string[];
      };
      const id = q.filterGroups[0]!.filters.find(
        (f) => f.propertyName === "hs_latest_sequence_enrolled",
      )!.value;
      const s = SEQUENCES.find((x) => x.id === id)!;
      const enrolled = new Date(s.createdAt.getTime() + DAY).toISOString();
      const later = new Date(s.createdAt.getTime() + 3 * DAY).toISOString();
      return json(200, {
        results: Array.from({ length: 30 }, (_, i) => ({
          id: `c${id}-${i}`,
          properties: {
            hs_latest_sequence_enrolled_date: enrolled,
            hs_sales_email_last_replied: i < s.replied ? later : null,
            engagements_last_meeting_booked: i < Math.floor(s.replied / 3) ? later : null,
          },
        })),
      });
    }
    json(404, { error: "unknown" });
  });
}

// --- Setup ------------------------------------------------------------------------------------

async function person(name: string) {
  who[name] = await db.withTenant(tenantId, async (tx) => {
    const { member } = await memberRepo.ensureMember(tx, tenantId, {
      workosUserId: `u_${name}`,
      email: `${name.toLowerCase()}@acme.test`,
      displayName: name,
    });
    const [t] = await tx
      .select()
      .from(teams)
      .where(sql`name = 'Revenue'`);
    const teamId =
      t?.id ?? (await tx.insert(teams).values({ tenantId, name: "Revenue" }).returning())[0]!.id;
    await memberRepo.addMemberToTeam(tx, tenantId, teamId, member.id);
    const { agent, key } = await agentRepo.createAgent(tx, tenantId, {
      memberId: member.id,
      name: "Claude Code",
      kind: "claude_code",
      createdByMemberId: member.id,
    });
    return { memberId: member.id, agentId: agent.id, key };
  });
}

async function mcp(name: string) {
  const c = new Client({ name: `${name}-agent`, version: "1" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${api}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${who[name]!.key}` } },
    }),
  );
  return async (tool: string, args: Record<string, unknown>) => {
    const r = await c.callTool({ name: tool, arguments: args });
    return {
      ok: !r.isError,
      data: r.structuredContent as Record<string, unknown>,
      text: (r.content as { text: string }[])[0]?.text ?? "",
    };
  };
}

async function until(pred: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const T = <R>(fn: (tx: TenantTx) => Promise<R>) => db.withTenant(tenantId, fn);

beforeAll(async () => {
  fake = fakeServer();
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  env = await startTestDatabase();
  db = createDb({ connectionString: env.appUrl, max: 10 });
  const t = await db.system.provisionTenant({
    name: "Acme",
    slug: "acme",
    workosOrgId: "org_acme",
    admin: { workosUserId: "admin", email: "admin@acme.test", displayName: "Admin" },
  });
  tenantId = t.tenantId;
  adminId = t.adminMemberId;
  await person("Dana");
  await person("Lior");
  const redactorFor = tenantRedactors({ db, pseudonymSecret: PSEUDO, ttlMs: 0 });
  queue = await createQueue({ connectionString: env.appUrl, onError: () => {} });
  const bronze = memoryBronze();
  await startIngestWorkers(queue, { db, bronze, redactorFor });
  app = await buildApp({
    db,
    queue,
    bronze,
    redactorFor,
    webUrl: "https://mm.test",
    slackSigningSecret: SIGNING,
    slackResponseOrigins: [fakeUrl],
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  api = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  process.env.MM_HOME = mkdtempSync(join(tmpdir(), "mm-delivery-"));
});

afterAll(async () => {
  await app?.close();
  await queue?.stop();
  await db?.close();
  await env?.stop();
  fake?.close();
});

// --- 1. Skills reach agents ---------------------------------------------------------------------

describe("an approved v2 skill reaches an agent; a retired one disappears", () => {
  it("serves only the approved version, keeps the bridge's skill files in step, and records use", async () => {
    const skillId = crypto.randomUUID();
    const body = (v: number) =>
      JSON.stringify({
        when_to_use: `Fixing a bug that users reported (v${v})`,
        preconditions: [],
        steps: [
          {
            text:
              v === 1
                ? "Reproduce it in a failing test"
                : "Reproduce it in a failing test, then bisect",
            evidence: [],
          },
        ],
        anti_patterns: [],
        expected_outcome: "Fewer reopened bugs",
      });
    await T(async (tx) => {
      await tx.execute(sql`
        INSERT INTO skills (id, tenant_id, pack, category, practice_key, title, current_version)
        VALUES (${skillId}, ${tenantId}, 'engineering', 'bugfix', 'repro', 'Reproduce bugs in a failing test', 1)`);
      await tx.execute(sql`
        INSERT INTO skill_versions (tenant_id, skill_id, version, title, body, evidence, gate)
        VALUES (${tenantId}, ${skillId}, 1, 'Reproduce bugs in a failing test', ${body(1)}::jsonb,
                '{"success":["a","b"],"failure":["c"]}', '{}')`);
    });
    const dana = await mcp("Dana");

    // Waiting for review: agents get nothing.
    expect((await dana("search_skills", { query: "bug" })).data).toEqual({ skills: [] });
    expect((await dana("get_skill", { skill_id: skillId })).data).toEqual({
      status: "not_approved",
    });

    await T((tx) => reviewSkill(tx, tenantId, { skillId, memberId: adminId, action: "approve" }));
    await T((tx) =>
      setSubscription(tx, tenantId, {
        memberId: who.Dana!.memberId,
        pack: "engineering",
        category: "bugfix",
        on: true,
      }),
    );
    const found = await dana("search_skills", { query: "failing test" });
    expect(found.data.skills).toMatchObject([{ id: skillId, version: 1 }]);

    // The bridge installs it as a Claude Code skill.
    const skillsDir = mkdtempSync(join(tmpdir(), "mm-skills-"));
    const bridgeApi = createApi(api, who.Dana!.key);
    const first = await syncSkills(bridgeApi, skillsDir);
    expect(first.written).toHaveLength(1);
    const folder = join(skillsDir, first.written[0]!);
    expect(readFileSync(join(folder, "SKILL.md"), "utf8")).toContain("version 1");

    // v2 arrives from the gate and waits for review: agents keep getting v1.
    await T(async (tx) => {
      await tx.execute(sql`
        INSERT INTO skill_versions (tenant_id, skill_id, version, title, body, evidence, gate)
        VALUES (${tenantId}, ${skillId}, 2, 'Reproduce bugs in a failing test', ${body(2)}::jsonb,
                '{"success":["a","b","d"],"failure":["c"]}', '{}')`);
      await tx.execute(
        sql`UPDATE skills SET current_version = 2, status = 'in_review' WHERE id = ${skillId}`,
      );
    });
    expect((await dana("get_skill", { skill_id: skillId })).data).toMatchObject({
      status: "served",
      skill: { version: 1 },
    });

    // Approved: v2 reaches the agent, over MCP and as the installed skill file.
    await T((tx) => reviewSkill(tx, tenantId, { skillId, memberId: adminId, action: "approve" }));
    const v2 = await dana("get_skill", { skill_id: skillId });
    expect(v2.data).toMatchObject({ status: "served", skill: { version: 2 } });
    expect(v2.text).toContain("then bisect");
    expect((await syncSkills(bridgeApi, skillsDir)).written).toHaveLength(1);
    expect(readFileSync(join(folder, "SKILL.md"), "utf8")).toContain("then bisect");
    // Dana follows the category, so she's told (as a Slack DM, once Slack is connected).
    const told = await T((tx) =>
      tx.select().from(notifications).where(eq(notifications.memberId, who.Dana!.memberId)),
    );
    expect(told.map((n) => n.kind)).toContain("skill_approved");

    // The agent says it followed v2 when logging the task.
    const logged = await dana("log_task", {
      title: "Fix rounding bug in invoices",
      summary: "Reproduced it in a failing test, bisected to the tax change, fixed.",
      skills_used: [{ skill_id: skillId, version: 2 }],
    });
    expect(logged.ok).toBe(true);
    await until(async () => (await T((tx) => tx.select().from(skillUsage))).length === 1);
    expect((await T((tx) => tx.select().from(skillUsage)))[0]).toMatchObject({
      skillId,
      version: 2,
      taskId: logged.data.task_id,
      adherence: "followed",
    });

    // Retired: gone from search, get_skill says so, and the bridge removes the file.
    await T((tx) => reviewSkill(tx, tenantId, { skillId, memberId: adminId, action: "retire" }));
    expect((await dana("search_skills", { query: "failing test" })).data).toEqual({ skills: [] });
    const gone = await dana("get_skill", { skill_id: skillId });
    expect(gone.data).toEqual({ status: "retired" });
    expect(gone.text).toMatch(/retired/);
    expect((await syncSkills(bridgeApi, skillsDir)).removed).toHaveLength(1);
    expect(existsSync(folder)).toBe(false);
    expect(readdirSync(skillsDir)).toEqual([]);

    // The use is in the lake.
    const lake = localLake();
    await publishOutbox({ db, sink: lake });
    expect(await lake.rows(tenantId, "skill_usage")).toMatchObject([
      { skill_id: skillId, version: 2 },
    ]);
  });
});

// --- 2. Slack approval ----------------------------------------------------------------------------

describe("a channel is approved from Slack", () => {
  it("DMs both people with buttons; their signed clicks open it; forged or replayed clicks don't", async () => {
    await T(async (tx) => {
      const { connection } = await connectionRepo.upsertConnection(tx, tenantId, {
        provider: "slack",
        externalId: "TACME",
        accountLogin: "acme",
        createdByMemberId: adminId,
      });
      const sealed = await vault.seal(tenantId, botTokenPurpose(connection.id), BOT_TOKEN);
      await connectionRepo.saveSecret(tx, tenantId, connection.id, "bot_token", sealed);
      for (const [name, client] of [
        ["Dana", "cc-dana"],
        ["Lior", "cursor-lior"],
      ] as const) {
        await tx.insert(agentSessions).values({
          tenantId,
          agentIdentityId: who[name]!.agentId,
          memberId: who[name]!.memberId,
          clientSessionId: client,
        });
      }
    });
    const [danaSession] = await T((tx) =>
      tx.select().from(agentSessions).where(eq(agentSessions.clientSessionId, "cc-dana")),
    );
    // Earlier notifications (skill updates) go out first; only the channel ones matter here.
    await sendNotifications(
      { db, vault, webUrl: "https://mm.test", slackBaseUrl: `${fakeUrl}/slack` },
      tenantId,
    );
    posted.length = 0;

    const lior = await mcp("Lior");
    const req = await lior("channel_request", {
      session_id: "cursor-lior",
      with_session_id: danaSession!.id,
      purpose: "Both editing the Q3 outbound sequence; agree who changes step 2.",
      resources: ["hubspot:sequence:1020"],
      share: ["intents", "messages"],
      ttl_minutes: 120,
    });
    expect(req.data).toMatchObject({ status: "requested" });
    const channelId = req.data.channel_id as string;

    const out = await sendNotifications(
      { db, vault, webUrl: "https://mm.test", slackBaseUrl: `${fakeUrl}/slack` },
      tenantId,
    );
    expect(out).toMatchObject({ sent: 2, failed: 0 });
    expect(posted.map((m) => m.channel).sort()).toEqual(["UDANA", "ULIOR"]);
    for (const m of posted) {
      const buttons = m.blocks.find((b) => b.type === "actions")!.elements!;
      expect(buttons.filter((b) => b.action_id).map((b) => [b.action_id, b.value])).toEqual([
        ["mm_channel_approve", channelId],
        ["mm_channel_decline", channelId],
      ]);
    }
    const members_ = await T((tx) => tx.select().from(members));
    expect(members_.find((m) => m.id === who.Dana!.memberId)!.slackUserId).toBe("UDANA");

    const click = (user: string, opts: { secret?: string; age?: number; action?: string } = {}) => {
      const payload = {
        type: "block_actions",
        team: { id: "TACME" },
        user: { id: user },
        actions: [{ action_id: opts.action ?? "mm_channel_approve", value: channelId }],
        response_url: `${fakeUrl}/respond/${user}`,
      };
      const raw = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
      const ts = Math.floor(Date.now() / 1000) - (opts.age ?? 0);
      return fetch(`${api}/webhooks/slack/interactions`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": String(ts),
          "x-slack-signature": signSlackRequest(opts.secret ?? SIGNING, ts, raw),
        },
        body: raw,
      });
    };

    // Not from Slack: wrong secret, a replay from 10 minutes ago, an agent key. Nothing changes.
    expect((await click("UDANA", { secret: "guessed" })).status).toBe(401);
    expect((await click("UDANA", { age: 600 })).status).toBe(401);
    const agentTry = await fetch(`${api}/webhooks/slack/interactions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${who.Dana!.key}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "payload=%7B%7D",
    });
    expect(agentTry.status).toBe(401);
    // Someone whose Slack account Master Mind doesn't know can't decide for anyone.
    expect((await click("USTRANGER")).status).toBe(200);
    const status = async () =>
      (await T((tx) => tx.select().from(channels).where(eq(channels.id, channelId))))[0]!.status;
    expect(await status()).toBe("requested");

    expect((await click("UDANA")).status).toBe(200);
    expect(await status()).toBe("requested");
    expect((await click("ULIOR")).status).toBe(200);
    expect(await status()).toBe("open");
    await until(() => responses.length >= 3);
    expect(responses.map((r) => r.text)).toEqual(
      expect.arrayContaining([
        "Master Mind doesn't know your Slack account. Decide in the web app instead.",
        "You approved. It opens once the other person approves too.",
        "You approved. The channel is open.",
      ]),
    );
    const parts = await T((tx) =>
      tx.select().from(channelParticipants).where(eq(channelParticipants.channelId, channelId)),
    );
    expect(parts.map((p) => p.approvedVia)).toEqual(["slack", "slack"]);
    const audit = await T((tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(sql`target_id = ${channelId} AND action = 'channel.approved'`),
    );
    expect(audit.map((a) => [a.actorId, (a.payload as { via: string }).via]).sort()).toEqual(
      [
        [who.Dana!.memberId, "slack"],
        [who.Lior!.memberId, "slack"],
      ].sort(),
    );
  });
});

// --- 3. HubSpot ------------------------------------------------------------------------------------

describe("a HubSpot sequence is judged", () => {
  it("imports sequences, credits the owner, measures replies, judges, and links the agent's work", async () => {
    const danaAgent = await mcp("Dana");
    // Dana's agent wrote two sequences: one it names, one it doesn't.
    const named = await danaAgent("log_task", {
      title: "Wrote the CFO follow-up sequence",
      summary: "Three short emails, a call task on day 4, a case study in email 2.",
      external_refs: ["hubspot:sequence:1025"],
      completed_at: new Date(SEQUENCES[24]!.createdAt.getTime() - 3_600_000).toISOString(),
    });
    const unnamed = await danaAgent("log_task", {
      title: "Draft outbound sequence for CFOs",
      summary: "Personalized first line from the prospect's last earnings call.",
      completed_at: new Date(SEQUENCES[19]!.createdAt.getTime() - 2 * 3_600_000).toISOString(),
    });
    await until(async () => (await T((tx) => tx.select().from(tasks))).length >= 3);

    const conn = await T(
      async (tx) =>
        (
          await connectionRepo.upsertConnection(tx, tenantId, {
            provider: "hubspot",
            externalId: "999",
            accountLogin: "acme.hubspot.com",
            createdByMemberId: adminId,
          })
        ).connection,
    );
    await storeRefreshToken({ db, vault }, tenantId, conn.id, REFRESH);
    const categorize: { tenantId: string; taskId: string }[] = [];
    const deps: HubspotDeps = {
      db,
      vault,
      redactorFor: tenantRedactors({ db, pseudonymSecret: PSEUDO, ttlMs: 0 }),
      config: {
        clientId: "c",
        clientSecret: "s",
        redirectUri: "https://mm.test/cb",
        apiUrl: `${fakeUrl}/hubspot`,
      },
      enqueue: async (_n, data) => {
        categorize.push(data as { tenantId: string; taskId: string });
      },
      now: () => NOW,
    };

    expect(await syncHubspot(deps, tenantId)).toBe(25);
    // Matched by work email (case aside): Dana now gets credit for her sequences.
    const dana = (
      await T((tx) => tx.select().from(members).where(eq(members.id, who.Dana!.memberId)))
    )[0]!;
    expect(dana.hubspotUserId).toBe(501);
    const seqTasks = await T((tx) => tx.select().from(tasks).where(eq(tasks.source, "hubspot")));
    expect(seqTasks).toHaveLength(25);
    expect(
      seqTasks.every((t) => t.memberId === who.Dana!.memberId && t.actorKey === "hubspot:501"),
    ).toBe(true);
    expect(
      await T((tx) => tx.execute(sql`SELECT count(*)::int AS n FROM hubspot_sequences`)),
    ).toMatchObject({
      rows: [{ n: 25 }],
    });

    const packs = builtinPacks();
    expect(categorize).toHaveLength(25);
    for (const job of categorize) await categorizeTask({ db, packs, llm: null }, job);
    const categorized = await T((tx) => tx.select().from(tasks).where(eq(tasks.source, "hubspot")));
    expect(new Set(categorized.map((t) => `${t.pack}/${t.category}`))).toEqual(
      new Set(["revenue/prospecting_sequence"]),
    );

    expect(await finalizeSequenceOutcomes(deps, tenantId)).toBe(25);
    const rate = await T((tx) =>
      tx.execute<{ value: number; n: number }>(sql`
        SELECT m.value, m.n FROM metric_observations m JOIN hubspot_sequences s ON s.task_id = m.task_id
         WHERE s.sequence_id = '1025' AND m.metric_key = 'sequence.reply_rate'`),
    );
    expect(rate.rows[0]).toMatchObject({ n: 30 });
    expect(Number(rate.rows[0]!.value)).toBeCloseTo(20 / 30, 3);

    await judgeSweep({ db, packs }, tenantId);
    const verdict = async (sequenceId: string) =>
      (
        await T((tx) =>
          tx.execute<{ verdict: string }>(sql`
            SELECT j.verdict FROM judgments j JOIN hubspot_sequences s ON s.task_id = j.task_id
             WHERE s.sequence_id = ${sequenceId}`),
        )
      ).rows[0]?.verdict;
    expect(await verdict("1025")).toBe("success");
    expect(await verdict("1024")).toBe("failure");
    // The earliest ones have no history to compare against yet.
    expect(await verdict("1001")).toBe("inconclusive");
    expect((await T((tx) => tx.select().from(judgments))).every((j) => j.pack === "revenue")).toBe(
      true,
    );

    // The agent's tasks are linked to the sequences they produced.
    await attributeTasks({ db, now: () => NOW }, tenantId);
    const links = await T((tx) => tx.select().from(taskAttributions));
    const seqTask = (id: string) =>
      seqTasks.find((t) => t.titleRedacted === SEQUENCES.find((s) => s.id === id)!.name)!.id;
    expect(links.find((l) => l.taskId === named.data.task_id)).toMatchObject({
      targetTaskId: seqTask("1025"),
      method: "reference",
      confidence: 1,
    });
    const guessed = links.find((l) => l.taskId === unnamed.data.task_id)!;
    expect(guessed).toMatchObject({ targetTaskId: seqTask("1020"), method: "heuristic" });
    expect(guessed.confidence).toBeGreaterThanOrEqual(0.7);
    expect(guessed.confidence).toBeLessThan(1);

    // Judgments reach the lake. No contact data was stored anywhere: counts only.
    const lake = localLake();
    await publishOutbox({ db, sink: lake });
    const lakeJudgments = await lake.rows(tenantId, "judgments");
    expect(lakeJudgments.filter((r) => r.source === "hubspot")).toHaveLength(25);
    const stored = JSON.stringify(
      await T((tx) => tx.execute(sql`SELECT * FROM hubspot_sequences`)),
    );
    expect(stored).not.toMatch(/c10\d\d-/);
  });
});
