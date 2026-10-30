// GitHub installations, linked accounts, and connector tasks in search and erasure.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type MasterMindDb } from "../src/client.ts";
import {
  AccountAlreadyLinkedError,
  ConnectionConflictError,
  connectionRepo,
  erasureRepo,
  historyRepo,
  memberRepo,
  sql,
  tasks,
} from "../src/index.ts";
import { startTestDatabase, type TestDatabase } from "../src/testing.ts";

let env: TestDatabase;
let db: MasterMindDb;
let A: { tenantId: string; adminMemberId: string };
let B: { tenantId: string; adminMemberId: string };

async function prTask(tenantId: string, githubUserId: number, title: string) {
  const id = randomUUID();
  await db.withTenant(tenantId, (tx) =>
    tx.execute(sql`
      INSERT INTO tasks (id, tenant_id, actor_key, source, title_redacted)
      VALUES (${id}, ${tenantId}, ${`github:${githubUserId}`}, 'github', ${title})`),
  );
  return id;
}

async function addMember(tenantId: string, name: string) {
  return db.withTenant(tenantId, async (tx) => {
    const { member } = await memberRepo.ensureMember(tx, tenantId, {
      workosUserId: `user_${randomUUID()}`,
      email: `${name}@acme.test`,
      displayName: name,
    });
    return member.id;
  });
}

beforeAll(async () => {
  env = await startTestDatabase();
  db = createDb({ connectionString: env.appUrl });
  A = await db.system.provisionTenant({
    name: "Acme",
    slug: "acme",
    workosOrgId: "org_acme",
    admin: { workosUserId: "admin_a", email: "admin@acme.test", displayName: null },
  });
  B = await db.system.provisionTenant({
    name: "Beta",
    slug: "beta",
    workosOrgId: "org_beta",
    admin: { workosUserId: "admin_b", email: "admin@beta.test", displayName: null },
  });
});

afterAll(async () => {
  await db?.close();
  await env?.stop();
});

describe("GitHub installations", () => {
  it("belong to one tenant: another tenant can't claim the same installation", async () => {
    const { connection, created } = await db.withTenant(A.tenantId, (tx) =>
      connectionRepo.upsertGithubInstallation(tx, A.tenantId, {
        installationId: "1001",
        accountLogin: "acme",
        createdByMemberId: A.adminMemberId,
      }),
    );
    expect(created).toBe(true);
    expect(connection.backfillStatus).toBe("pending");

    // Re-installing in the same tenant reactivates it.
    const again = await db.withTenant(A.tenantId, (tx) =>
      connectionRepo.upsertGithubInstallation(tx, A.tenantId, {
        installationId: "1001",
        accountLogin: "acme",
        createdByMemberId: A.adminMemberId,
      }),
    );
    expect(again).toMatchObject({ created: false, connection: { id: connection.id } });

    await expect(
      db.withTenant(B.tenantId, (tx) =>
        connectionRepo.upsertGithubInstallation(tx, B.tenantId, {
          installationId: "1001",
          accountLogin: "acme",
          createdByMemberId: B.adminMemberId,
        }),
      ),
    ).rejects.toBeInstanceOf(ConnectionConflictError);
    // B sees nothing of A's connection.
    expect(await db.withTenant(B.tenantId, (tx) => connectionRepo.listConnections(tx))).toEqual([]);
  });

  it("resolve to their tenant before any tenant context exists (webhooks)", async () => {
    expect(await db.system.resolveConnection("github", "1001")).toMatchObject({
      tenantId: A.tenantId,
      status: "active",
    });
    expect(await db.system.resolveConnection("github", "9999")).toBeNull();
    expect((await db.health()).leakedTenantContext).toBeNull();
  });

  it("track backfill progress per repository", async () => {
    const [c] = await db.withTenant(A.tenantId, (tx) => connectionRepo.listConnections(tx));
    await db.withTenant(A.tenantId, async (tx) => {
      await connectionRepo.updateBackfill(tx, c!.id, {
        backfillStatus: "running",
        repo: { id: "77", name: "acme/api" },
      });
      await connectionRepo.updateBackfill(tx, c!.id, { repo: { id: "77", addPrs: 25 } });
      await connectionRepo.updateBackfill(tx, c!.id, { repo: { id: "77", addPrs: 3, done: true } });
    });
    const after = await db.withTenant(A.tenantId, (tx) => connectionRepo.getConnection(tx, c!.id));
    expect(after!.backfillStatus).toBe("running");
    expect(after!.backfillState).toEqual({ "77": { name: "acme/api", done: true, prs: 28 } });
  });
});

describe("linked GitHub accounts", () => {
  it("claim the PRs captured under that identity, and can't be linked twice", async () => {
    const dana = await addMember(A.tenantId, "dana");
    const pr = await prTask(A.tenantId, 4242, "Add proration");
    const res = await db.withTenant(A.tenantId, (tx) =>
      connectionRepo.linkGithubAccount(tx, dana, 4242),
    );
    expect(res.claimedTasks).toBe(1);
    const [t] = await db.withTenant(A.tenantId, (tx) =>
      tx
        .select()
        .from(tasks)
        .where(sql`id = ${pr}`),
    );
    expect(t!.memberId).toBe(dana);

    const other = await addMember(A.tenantId, "other");
    await expect(
      db.withTenant(A.tenantId, (tx) => connectionRepo.linkGithubAccount(tx, other, 4242)),
    ).rejects.toBeInstanceOf(AccountAlreadyLinkedError);
    // The same GitHub account can belong to a member of another tenant.
    const beta = await addMember(B.tenantId, "dana-at-beta");
    await db.withTenant(B.tenantId, (tx) => connectionRepo.linkGithubAccount(tx, beta, 4242));
  });

  it("unlinked PR authors show as a contributor in history search", async () => {
    await prTask(A.tenantId, 5150, "Refactor ledger rounding");
    const items = await db.withTenant(A.tenantId, (tx) =>
      historyRepo.searchHistory(tx, { requesterMemberId: A.adminMemberId, text: "ledger" }),
    );
    expect(items.map((i) => [i.title, i.who])).toEqual([
      ["Refactor ledger rounding", "a contributor"],
    ]);
  });
});

describe("erasure of a member with a linked GitHub account", () => {
  it("also removes connector tasks keyed only by their GitHub identity", async () => {
    const leaving = await addMember(A.tenantId, "leaving");
    await db.withTenant(A.tenantId, (tx) => connectionRepo.linkGithubAccount(tx, leaving, 777));
    // Captured after linking would get member_id; this one simulates one still keyed by actor.
    const orphan = await prTask(A.tenantId, 777, "Late webhook PR");
    const req = await db.withTenant(A.tenantId, (tx) =>
      erasureRepo.requestMemberErasure(tx, A.tenantId, {
        subjectMemberId: leaving,
        requestedByMemberId: A.adminMemberId,
      }),
    );
    expect(req.subjectActorKeys).toEqual(["github:777"]);
    const left = await db.withTenant(A.tenantId, (tx) =>
      tx
        .select()
        .from(tasks)
        .where(sql`id = ${orphan}`),
    );
    expect(left).toEqual([]);
  });
});
