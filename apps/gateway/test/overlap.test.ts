// Week 7 check: two Claude Code sessions editing overlapping lines both get an alert within
// 5 seconds. Real queue and ingest worker, real gateway, two real bridge presence processes.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { files, requestStop, runPresence, takeAlerts } from "@mm/bridge/presence";
import {
  agentRepo,
  createDb,
  memberRepo,
  sql,
  teams,
  type AuthenticatedAgent,
  type MasterMindDb,
} from "@mm/db";
import { createQueue, type QueueClient } from "@mm/db/queue";
import { startTestDatabase, type TestDatabase } from "@mm/db/testing";
import {
  acceptActions,
  actionBatchInput,
  memoryBronze,
  startIngestWorkers,
  tenantRedactors,
} from "@mm/ingest";
import { signGatewayToken, type OverlapAlert } from "@mm/realtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGateway } from "../src/gateway.ts";

const SECRET = "o".repeat(48);
let env: TestDatabase;
let db: MasterMindDb;
let queue: QueueClient;
let gw: Awaited<ReturnType<typeof createGateway>>;
let url: string;
let tenantId: string;
const agents: Record<string, AuthenticatedAgent> = {};
const bronze = memoryBronze();

async function person(name: string) {
  agents[name] = await db.withTenant(tenantId, async (tx) => {
    const { member } = await memberRepo.ensureMember(tx, tenantId, {
      workosUserId: `u_${name}`,
      email: `${name.toLowerCase()}@acme.test`,
      displayName: name,
    });
    await tx.execute(sql`UPDATE members SET visibility_pref = 'name' WHERE id = ${member.id}`);
    const [t] = await tx
      .select()
      .from(teams)
      .where(sql`name = 'Billing'`);
    const teamId =
      t?.id ?? (await tx.insert(teams).values({ tenantId, name: "Billing" }).returning())[0]!.id;
    await memberRepo.addMemberToTeam(tx, tenantId, teamId, member.id);
    const { agent } = await agentRepo.createAgent(tx, tenantId, {
      memberId: member.id,
      name: "Claude Code",
      kind: "claude_code",
      createdByMemberId: member.id,
    });
    return {
      tenantId,
      agentId: agent.id,
      memberId: member.id,
      scopes: agent.scopes,
      captureOptOut: false,
    };
  });
}

beforeAll(async () => {
  env = await startTestDatabase();
  db = createDb({ connectionString: env.appUrl, max: 8 });
  tenantId = (
    await db.system.provisionTenant({
      name: "Acme",
      slug: "acme",
      workosOrgId: "org_acme",
      admin: { workosUserId: "admin", email: "admin@acme.test", displayName: null },
    })
  ).tenantId;
  await person("Dana");
  await person("Lior");
  queue = await createQueue({ connectionString: env.appUrl, onError: () => {} });
  await startIngestWorkers(queue, {
    db,
    bronze,
    redactorFor: tenantRedactors({ db, pseudonymSecret: "p".repeat(40), ttlMs: 0 }),
  });
  gw = await createGateway({
    db,
    listenUrl: env.appUrl,
    secret: SECRET,
    redactorFor: tenantRedactors({ db, pseudonymSecret: "p".repeat(40), ttlMs: 0 }),
    sweepMs: 60_000,
  });
  await new Promise<void>((r) => gw.server.listen(0, "127.0.0.1", () => r()));
  url = `ws://127.0.0.1:${(gw.server.address() as AddressInfo).port}`;
  process.env.MM_HOME = mkdtempSync(join(tmpdir(), "mm-overlap-"));
});

afterAll(async () => {
  delete process.env.MM_HOME;
  await gw?.close();
  await queue?.stop();
  await db?.close();
  await env?.stop();
});

const bridge = (name: string, sessionId: string) =>
  runPresence({
    sessionId,
    cwd: `/work/${name}`,
    session: {
      repo: "github.com/acme/api",
      branch: `${name.toLowerCase()}-feature`,
      tool: "claude_code",
    },
    getToken: async () => ({
      token: signGatewayToken(SECRET, {
        tenantId,
        agentId: agents[name]!.agentId,
        memberId: agents[name]!.memberId,
      }).token,
      gatewayUrl: url,
    }),
    heartbeatMs: 1_000,
    checkMs: 50,
  });

/** What the bridge's PostToolUse hook sends after an Edit (see apps/bridge/src/capture.ts). */
const edit = (name: string, sessionId: string, lines: [number, number]) =>
  acceptActions(
    { queue, bronze },
    agents[name]!,
    actionBatchInput.parse({
      session: { id: sessionId, repo: "github.com/acme/api", tool: "claude_code" },
      events: [
        {
          id: crypto.randomUUID(),
          kind: "edit",
          summary: "Edited src/billing/invoice.ts",
          resources: [`git:github.com/acme/api:src/billing/invoice.ts#L${lines[0]}-${lines[1]}`],
          occurred_at: new Date().toISOString(),
        },
      ],
    }),
    "bridge",
  );

const pending = (sessionId: string): OverlapAlert[] => {
  const f = files(sessionId).alerts;
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as OverlapAlert[]) : [];
};

describe("week 7 check: overlapping edits alert both sessions within 5 seconds", () => {
  it("both bridges get a same-lines alert, once, and the agent is told", async () => {
    const danaDone = bridge("Dana", "cc-dana");
    const liorDone = bridge("Lior", "cc-lior");
    // Both connected and visible to each other.
    const until = async (pred: () => boolean, ms: number) => {
      const end = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    await until(
      () => existsSync(files("cc-dana").presence) && existsSync(files("cc-lior").presence),
      5_000,
    );

    await edit("Dana", "cc-dana", [40, 80]);
    await new Promise((r) => setTimeout(r, 1_500)); // Dana's edit is in before Lior starts
    const started = Date.now();
    await edit("Lior", "cc-lior", [60, 95]);
    await until(() => pending("cc-dana").length > 0 && pending("cc-lior").length > 0, 5_000);
    const elapsed = Date.now() - started;
    console.log(`both alerted ${elapsed} ms after the overlapping edit`);
    expect(elapsed).toBeLessThan(5_000);

    expect(pending("cc-dana")).toEqual([
      expect.objectContaining({
        kind: "same_lines",
        severity: "high",
        with: "Lior",
        shared_lines: [[60, 80]],
        text: "Conflict likely: Lior is changing the same lines of git:github.com/acme/api:src/billing/invoice.ts (lines 60-80).",
      }),
    ]);
    expect(pending("cc-lior")[0]).toMatchObject({
      with: "Dana",
      your_lines: [[60, 95]],
      their_lines: [[40, 80]],
    });

    // The next hook tells the agent once.
    expect(takeAlerts("cc-dana")).toContain("Conflict likely: Lior");
    expect(takeAlerts("cc-dana")).toBeNull();

    // More edits on the same lines don't alert again.
    await edit("Lior", "cc-lior", [70, 75]);
    await new Promise((r) => setTimeout(r, 2_500));
    expect(pending("cc-dana")).toEqual([]);

    requestStop("cc-dana");
    requestStop("cc-lior");
    await Promise.all([danaDone, liorDone]);
  });
});
