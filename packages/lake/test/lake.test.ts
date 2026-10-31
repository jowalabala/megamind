// Outbox publishing and member erasure against a real Postgres and the local lake.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentRepo,
  auditEvents,
  createDb,
  erasureRepo,
  eq,
  erasureRequests,
  lakeOutbox,
  memberRepo,
  sql,
  type MasterMindDb,
} from "@mm/db";
import { adminQuery, startTestDatabase, type TestDatabase } from "@mm/db/testing";
import {
  actionRecord,
  enqueueLakeRecords,
  localLake,
  processErasures,
  publishOutbox,
  taskRecord,
  type LakeSink,
  type LocalLake,
} from "../src/index.ts";

let env: TestDatabase;
let db: MasterMindDb;
let A: string;
let B: string;
let adminA: string;

async function member(tenantId: string, name: string) {
  return db.withTenant(tenantId, async (tx) => {
    const { member } = await memberRepo.ensureMember(tx, tenantId, {
      workosUserId: `user_${randomUUID()}`,
      email: `${name}@acme.test`,
      displayName: name,
    });
    const { agent } = await agentRepo.createAgent(tx, tenantId, {
      memberId: member.id,
      name: "Claude Code",
      kind: "claude_code",
      createdByMemberId: member.id,
    });
    return { memberId: member.id, agentId: agent.id };
  });
}

async function capture(tenantId: string, who: { memberId: string; agentId: string }, n = 1) {
  await db.withTenant(tenantId, (tx) =>
    enqueueLakeRecords(
      tx,
      tenantId,
      Array.from({ length: n }, (_, i) =>
        actionRecord({
          id: randomUUID(),
          tenantId,
          memberId: who.memberId,
          agentId: who.agentId,
          source: "bridge",
          sessionId: randomUUID(),
          taskId: null,
          private: false,
          kind: "edit",
          summary: `Edited invoice.ts (${i})`,
          resources: ["git:github.com/acme/api:src/billing/invoice.ts#L1-9"],
          occurredAt: new Date(Date.now() - i * 1000),
          ingestedAt: new Date(),
        }),
      ),
    ),
  );
}

const outboxCount = async (tenantId: string) =>
  db.withTenant(tenantId, async (tx) => (await tx.select().from(lakeOutbox)).length);

beforeAll(async () => {
  env = await startTestDatabase();
  db = createDb({ connectionString: env.appUrl, max: 4 });
  const a = await db.system.provisionTenant({
    name: "Acme",
    slug: "acme",
    workosOrgId: "org_acme",
    admin: { workosUserId: "user_admin_a", email: "admin@acme.test", displayName: null },
  });
  A = a.tenantId;
  adminA = a.adminMemberId;
  B = (
    await db.system.provisionTenant({
      name: "Beta",
      slug: "beta",
      workosOrgId: "org_beta",
      admin: { workosUserId: "user_admin_b", email: "admin@beta.test", displayName: null },
    })
  ).tenantId;
});

afterAll(async () => {
  await db?.close();
  await env?.stop();
});

describe("publishOutbox", () => {
  it("moves rows to each tenant's own namespace and empties the outbox", async () => {
    const lake = localLake();
    const dana = await member(A, "dana");
    const beta = await member(B, "bob");
    await capture(A, dana, 3);
    await capture(B, beta, 2);

    const res = await publishOutbox({ db, sink: lake, batchSize: 2 });
    expect(res).toEqual({ published: 5, failed: 0 });
    expect(await outboxCount(A)).toBe(0);
    expect(await outboxCount(B)).toBe(0);
    expect((await lake.tableCounts(A)).actions).toBe(3);
    expect((await lake.tableCounts(B)).actions).toBe(2);
    const recent = await lake.recentActions(A, { resource: "src/billing" });
    expect(recent.map((r) => r.member_id)).toEqual([dana.memberId, dana.memberId, dana.memberId]);
    // Newest first.
    expect(recent[0]!.summary).toBe("Edited invoice.ts (0)");
  });

  it("keeps rows the sink rejected, and retries them next time", async () => {
    const lake = localLake();
    const dana = await member(A, "dana2");
    await capture(A, dana, 3);
    let calls = 0;
    const flaky: LakeSink = {
      async put(tenantId, records) {
        calls++;
        if (calls === 1) {
          await lake.put(tenantId, records.slice(1));
          return { failedIds: [records[0]!.id] };
        }
        return lake.put(tenantId, records);
      },
    };
    expect(await publishOutbox({ db, sink: flaky })).toEqual({ published: 2, failed: 1 });
    expect(await outboxCount(A)).toBe(1);
    expect(await publishOutbox({ db, sink: flaky })).toEqual({ published: 1, failed: 0 });
    expect(await outboxCount(A)).toBe(0);
  });

  it("keeps everything when the sink throws", async () => {
    const dana = await member(A, "dana3");
    await capture(A, dana, 2);
    const broken: LakeSink = {
      async put() {
        throw new Error("firehose down");
      },
    };
    await expect(publishOutbox({ db, sink: broken })).rejects.toThrow("firehose down");
    expect(await outboxCount(A)).toBe(2);
    await publishOutbox({ db, sink: localLake() });
    expect(await outboxCount(A)).toBe(0);
  });

  it("holds rows for tenants whose lake isn't provisioned yet", async () => {
    const lake = localLake();
    const dana = await member(A, "dana4");
    await capture(A, dana, 1);
    expect(await publishOutbox({ db, sink: lake, requireProvisioned: true })).toEqual({
      published: 0,
      failed: 0,
    });
    expect(await outboxCount(A)).toBe(1);
    await adminQuery(env.adminUrl, "UPDATE tenants SET lake_ready_at = now() WHERE id = $1", [A]);
    expect(await publishOutbox({ db, sink: lake, requireProvisioned: true })).toEqual({
      published: 1,
      failed: 0,
    });
  });

  it("two publishers running at once never send a row twice", async () => {
    const dana = await member(A, "dana5");
    await capture(A, dana, 40);
    const sentIds: number[] = [];
    const slow: LakeSink = {
      async put(_tenantId, records) {
        await new Promise((r) => setTimeout(r, 20));
        sentIds.push(...records.map((r) => r.id));
        return { failedIds: [] };
      },
    };
    await Promise.all([
      publishOutbox({ db, sink: slow, batchSize: 5 }),
      publishOutbox({ db, sink: slow, batchSize: 5 }),
    ]);
    expect(sentIds).toHaveLength(40);
    expect(new Set(sentIds).size).toBe(40);
  });
});

describe("processErasures", () => {
  let lake: LocalLake;
  const raw = new Map<string, string[]>();
  const deleteRaw = async (tenantId: string, memberId: string) => {
    raw.delete(`${tenantId}/${memberId}`);
  };

  it("removes raw payloads and lake rows in two passes, then records when old copies expire", async () => {
    lake = localLake();
    const leaving = await member(A, "leaving");
    const staying = await member(A, "staying");
    raw.set(`${A}/${leaving.memberId}`, ["raw-1"]);
    await capture(A, leaving, 3);
    await capture(A, staying, 2);
    await db.withTenant(A, (tx) =>
      enqueueLakeRecords(tx, A, [
        taskRecord({
          id: randomUUID(),
          tenantId: A,
          memberId: leaving.memberId,
          agentId: leaving.agentId,
          source: "mcp",
          sessionId: null,
          private: false,
          title: "Leaving task",
          summary: "",
          categoryHint: null,
          externalRefs: [],
          features: {},
          startedAt: null,
          completedAt: null,
          createdAt: new Date(),
          ingestedAt: new Date(),
        }),
      ]),
    );
    await publishOutbox({ db, sink: lake });
    // One more row still "buffered in Firehose" when the request is made.
    await capture(A, leaving, 1);
    const buffered = await db.withTenant(A, (tx) => tx.select().from(lakeOutbox));

    const req = await db.withTenant(A, (tx) =>
      erasureRepo.requestMemberErasure(tx, A, {
        subjectMemberId: leaving.memberId,
        requestedByMemberId: adminA,
      }),
    );

    let now = new Date();
    const opts = { db, lake, deleteRaw, now: () => now, requireProvisioned: true };
    expect(await processErasures(opts)).toBe(1);
    expect(raw.has(`${A}/${leaving.memberId}`)).toBe(false);
    expect(await lake.memberRowCounts(A, { memberId: leaving.memberId, actorKeys: [] })).toEqual({
      actions: 0,
      tasks: 0,
      metric_observations: 0,
      task_categories: 0,
      judgments: 0,
      channel_messages: 0,
    });
    // The buffered row lands after the first pass...
    await lake.put(
      A,
      buffered.map((r) => ({ id: r.id, table: r.lakeTable, eventId: r.eventId, row: r.row })),
    );
    expect(
      (await lake.memberRowCounts(A, { memberId: leaving.memberId, actorKeys: [] })).actions,
    ).toBe(1);

    // ...and nothing happens until the second pass is due.
    expect(await processErasures(opts)).toBe(0);
    now = new Date(now.getTime() + 16 * 60_000);
    expect(await processErasures(opts)).toBe(1);
    expect(
      (await lake.memberRowCounts(A, { memberId: leaving.memberId, actorKeys: [] })).actions,
    ).toBe(0);
    // Other members are untouched.
    expect(
      (await lake.memberRowCounts(A, { memberId: staying.memberId, actorKeys: [] })).actions,
    ).toBe(2);

    const [done] = await db.withTenant(A, (tx) =>
      tx.select().from(erasureRequests).where(eq(erasureRequests.id, req.id)),
    );
    expect(done!.status).toBe("done");
    expect(done!.physicallyErasedBy!.getTime()).toBe(now.getTime() + 11 * 86_400_000);
    const audit = await db.withTenant(A, (tx) =>
      tx
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(eq(auditEvents.targetId, req.id))
        .orderBy(auditEvents.seq),
    );
    expect(audit.map((a) => a.action)).toEqual([
      "member.erasure_first_pass",
      "member.erasure_completed",
    ]);
  });

  it("records failures and retries, giving up after the attempt limit", async () => {
    const victim = await member(A, "victim");
    const req = await db.withTenant(A, (tx) =>
      erasureRepo.requestMemberErasure(tx, A, {
        subjectMemberId: victim.memberId,
        requestedByMemberId: adminA,
      }),
    );
    const failing = async () => {
      throw new Error("S3 unavailable");
    };
    const opts = {
      db,
      lake: localLake(),
      deleteRaw: failing,
      maxAttempts: 2,
      requireProvisioned: true,
    };
    await processErasures(opts);
    let [row] = await db.withTenant(A, (tx) =>
      tx.select().from(erasureRequests).where(eq(erasureRequests.id, req.id)),
    );
    expect(row).toMatchObject({ status: "pending", attempts: 1, lastError: "S3 unavailable" });
    await processErasures(opts);
    [row] = await db.withTenant(A, (tx) =>
      tx.select().from(erasureRequests).where(eq(erasureRequests.id, req.id)),
    );
    expect(row).toMatchObject({ status: "failed", attempts: 2 });
  });

  it("deletes lake rows of unprovisioned tenants when the lake doesn't need provisioning (local)", async () => {
    const lake = localLake();
    const victim = await member(B, "local-victim");
    await capture(B, victim, 2);
    await publishOutbox({ db, sink: lake });
    expect(
      (await lake.memberRowCounts(B, { memberId: victim.memberId, actorKeys: [] })).actions,
    ).toBe(2);
    await db.withTenant(B, async (tx) => {
      const admin = await tx.execute<{ id: string }>(
        sql`SELECT id FROM members WHERE role = 'admin'`,
      );
      await erasureRepo.requestMemberErasure(tx, B, {
        subjectMemberId: victim.memberId,
        requestedByMemberId: admin.rows[0]!.id,
      });
    });
    await processErasures({ db, lake, deleteRaw: async () => {}, requireProvisioned: false });
    expect(
      (await lake.memberRowCounts(B, { memberId: victim.memberId, actorKeys: [] })).actions,
    ).toBe(0);
  });

  it("skips the lake for tenants without one", async () => {
    const victim = await member(B, "victim-b");
    await db.withTenant(B, async (tx) => {
      const admin = await tx.execute<{ id: string }>(
        sql`SELECT id FROM members WHERE role = 'admin'`,
      );
      await erasureRepo.requestMemberErasure(tx, B, {
        subjectMemberId: victim.memberId,
        requestedByMemberId: admin.rows[0]!.id,
      });
    });
    let lakeCalled = false;
    const spy = localLake();
    const lakeSpy = { ...spy, deleteMemberRows: async () => void (lakeCalled = true) };
    await processErasures({
      db,
      lake: lakeSpy,
      deleteRaw: async () => {},
      requireProvisioned: true,
    });
    expect(lakeCalled).toBe(false);
  });
});
