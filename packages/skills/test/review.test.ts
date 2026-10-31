import { randomUUID } from "node:crypto";
import { createDb, memberRepo, skillReviews, sql, type MasterMindDb, type TenantTx } from "@mm/db";
import { startTestDatabase, type TestDatabase } from "@mm/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getSkill,
  ReviewError,
  reviewQueue,
  reviewSkill,
  searchSkills,
  setCategoryOwner,
} from "../src/index.ts";

let env: TestDatabase;
let db: MasterMindDb;
let tenantId: string;
let admin: string;
let owner: string;
let member: string;
const T = <R>(fn: (tx: TenantTx) => Promise<R>) => db.withTenant(tenantId, fn);

async function skill(category: string, title: string, versions = 1) {
  const id = randomUUID();
  await T(async (tx) => {
    await tx.execute(sql`
      INSERT INTO skills (id, tenant_id, pack, category, practice_key, title, current_version)
      VALUES (${id}, ${tenantId}, 'engineering', ${category}, 'k', ${title}, ${versions})`);
    for (let v = 1; v <= versions; v++) {
      await tx.execute(sql`
        INSERT INTO skill_versions (tenant_id, skill_id, version, title, body, evidence, gate)
        VALUES (${tenantId}, ${id}, ${v}, ${`${title} v${v}`},
                ${JSON.stringify({ when_to_use: "w", preconditions: [], steps: [{ text: `Write a regression test (v${v})`, evidence: [] }], anti_patterns: [], expected_outcome: "o" })}::jsonb,
                '{"success":[],"failure":[]}', '{}')`);
    }
  });
  return id;
}

beforeAll(async () => {
  env = await startTestDatabase();
  db = createDb({ connectionString: env.appUrl });
  const t = await db.system.provisionTenant({
    name: "Acme",
    slug: "acme",
    workosOrgId: "org_acme",
    admin: { workosUserId: "admin", email: "admin@acme.test", displayName: null },
  });
  tenantId = t.tenantId;
  admin = t.adminMemberId;
  const add = (n: string) =>
    T(
      async (tx) =>
        (
          await memberRepo.ensureMember(tx, tenantId, {
            workosUserId: n,
            email: `${n}@acme.test`,
            displayName: n,
          })
        ).member.id,
    );
  owner = await add("owner");
  member = await add("member");
  await T((tx) =>
    setCategoryOwner(tx, tenantId, {
      adminId: admin,
      memberId: owner,
      pack: "engineering",
      category: "bugfix",
      owner: true,
    }),
  );
});

afterAll(async () => {
  await db?.close();
  await env?.stop();
});

describe("who may review", () => {
  it("admins and the category's owners; nobody else", async () => {
    const id = await skill("bugfix", "Reproduce bugs in a failing test");
    await expect(
      T((tx) => reviewSkill(tx, tenantId, { skillId: id, memberId: member, action: "approve" })),
    ).rejects.toBeInstanceOf(ReviewError);
    expect(
      await T((tx) =>
        reviewSkill(tx, tenantId, { skillId: id, memberId: owner, action: "approve" }),
      ),
    ).toEqual({ status: "approved", approvedVersion: 1 });
    const other = await skill("feature", "Ship behind a flag");
    await expect(
      T((tx) => reviewSkill(tx, tenantId, { skillId: other, memberId: owner, action: "approve" })),
    ).rejects.toBeInstanceOf(ReviewError);
    await T((tx) =>
      reviewSkill(tx, tenantId, { skillId: other, memberId: admin, action: "approve" }),
    );
    // Only admins assign owners.
    await expect(
      T((tx) =>
        setCategoryOwner(tx, tenantId, {
          adminId: owner,
          memberId: member,
          pack: "engineering",
          category: "bugfix",
          owner: true,
        }),
      ),
    ).rejects.toBeInstanceOf(ReviewError);
  });
});

describe("actions", () => {
  it("rollback serves an earlier version; retire and restore; history is kept", async () => {
    const id = await skill("bugfix", "Cache by lockfile hash", 3);
    await T((tx) => reviewSkill(tx, tenantId, { skillId: id, memberId: admin, action: "approve" }));
    expect((await T((tx) => getSkill(tx, id)))!.skill.approvedVersion).toBe(3);
    expect(
      await T((tx) =>
        reviewSkill(tx, tenantId, {
          skillId: id,
          memberId: admin,
          action: "rollback",
          version: 2,
          note: "v3 regressed",
        }),
      ),
    ).toEqual({ status: "approved", approvedVersion: 2 });
    await expect(
      T((tx) =>
        reviewSkill(tx, tenantId, { skillId: id, memberId: admin, action: "rollback", version: 9 }),
      ),
    ).rejects.toThrow(/doesn't exist/);
    expect(
      (
        await T((tx) =>
          reviewSkill(tx, tenantId, { skillId: id, memberId: admin, action: "retire" }),
        )
      ).status,
    ).toBe("retired");
    expect(
      (
        await T((tx) =>
          reviewSkill(tx, tenantId, { skillId: id, memberId: admin, action: "restore" }),
        )
      ).status,
    ).toBe("approved");
    const s = (await T((tx) => getSkill(tx, id)))!;
    expect(s.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(s.reviews.map((r) => r.action)).toEqual(["restore", "retire", "rollback", "approve"]);
    // Review history is append-only.
    await expect(T((tx) => tx.delete(skillReviews))).rejects.toThrow();
  });

  it("rejecting a first version retires the skill; rejecting a later one keeps serving the approved one", async () => {
    const fresh = await skill("bugfix", "Fresh idea");
    expect(
      (
        await T((tx) =>
          reviewSkill(tx, tenantId, { skillId: fresh, memberId: admin, action: "reject" }),
        )
      ).status,
    ).toBe("retired");
    const grown = await skill("bugfix", "Grown skill", 2);
    await T((tx) => tx.execute(sql`UPDATE skills SET approved_version = 1 WHERE id = ${grown}`));
    expect(
      await T((tx) =>
        reviewSkill(tx, tenantId, { skillId: grown, memberId: admin, action: "reject" }),
      ),
    ).toEqual({ status: "approved", approvedVersion: 1 });
  });
});

describe("library and queue", () => {
  it("search finds skills by their steps; the queue shows a reviewer only their categories", async () => {
    await skill("bugfix", "Pin flaky test seeds");
    await skill("feature", "Write the migration first");
    const hits = await T((tx) => searchSkills(tx, { text: "regression test" }));
    expect(hits.length).toBeGreaterThan(0);
    expect((await T((tx) => searchSkills(tx, { text: "migration" })))[0]!.title).toBe(
      "Write the migration first",
    );
    const forOwner = await T((tx) => reviewQueue(tx, owner));
    expect(forOwner.map((s) => s.category).every((c) => c === "bugfix")).toBe(true);
    expect((await T((tx) => reviewQueue(tx, admin))).some((s) => s.category === "feature")).toBe(
      true,
    );
    expect(await T((tx) => reviewQueue(tx, member))).toEqual([]);
  });
});
