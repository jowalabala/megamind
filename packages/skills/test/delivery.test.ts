import { randomUUID } from "node:crypto";
import {
  auditEvents,
  createDb,
  memberRepo,
  notifications,
  skills,
  skillMeasurements,
  sql,
  type MasterMindDb,
  type TenantTx,
} from "@mm/db";
import { startTestDatabase, type TestDatabase } from "@mm/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getServedSkill,
  liftOf,
  measureSkills,
  reviewSkill,
  skillMarkdown,
  skillSlug,
  subscribedSkills,
  setSubscription,
} from "../src/index.ts";

describe("liftOf", () => {
  it("needs enough work on both sides", () => {
    expect(liftOf({ n: 9, success: 9 }, { n: 50, success: 10 }).status).toBe("insufficient");
  });
  it("says a skill helps or hurts only when the whole interval agrees", () => {
    expect(liftOf({ n: 40, success: 30 }, { n: 60, success: 20 })).toMatchObject({
      status: "improves",
      lift: 0.4167,
    });
    expect(liftOf({ n: 12, success: 2 }, { n: 18, success: 14 }).status).toBe("degrades");
    expect(liftOf({ n: 12, success: 6 }, { n: 18, success: 9 }).status).toBe("no_effect");
    // All-or-nothing samples don't produce a zero-width interval.
    const r = liftOf({ n: 10, success: 10 }, { n: 10, success: 10 });
    expect(r.status).toBe("no_effect");
    expect(r.ciLow!).toBeLessThan(0);
  });
});

describe("SKILL.md", () => {
  it("has a valid Claude Code skill name and quoted description", () => {
    const md = skillMarkdown({
      id: "0d7c6f1e-0000-4000-8000-000000000000",
      version: 3,
      title: 'Reproduce bugs: "failing test" first!',
      pack: "engineering",
      category: "bugfix",
      when_to_use: "A user reported a bug.\nAny bug.",
      body: {
        when_to_use: "A user reported a bug.",
        preconditions: [],
        steps: [{ text: "Write a failing test", evidence: [] }],
        anti_patterns: [{ text: "Fixing before reproducing", evidence: [] }],
        expected_outcome: "Fewer reopened bugs",
      },
      evidence: { success: 5, failure: 2 },
      approved_at: null,
    });
    const name = /^name: (.+)$/m.exec(md)![1]!;
    expect(name).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(name).toBe("mm-reproduce-bugs-failing-test-first-0d7c6f1e");
    expect(md).toContain(
      'description: "Reproduce bugs: \\"failing test\\" first!. Use when: A user reported a bug. Any bug."',
    );
    expect(md).toContain("1. Write a failing test");
    expect(md).toContain('skill_id: "0d7c6f1e-0000-4000-8000-000000000000", version: 3');
  });
  it("slugs never come out empty", () => {
    expect(skillSlug({ id: "abcdef12-x", title: "!!!" })).toBe("mm-skill-abcdef12");
  });
});

let env: TestDatabase;
let db: MasterMindDb;
let tenantId: string;
let admin: string;
let member: string;
const T = <R>(fn: (tx: TenantTx) => Promise<R>) => db.withTenant(tenantId, fn);
const NOW = new Date();

async function skill(category: string) {
  const id = randomUUID();
  await T(async (tx) => {
    await tx.execute(sql`
      INSERT INTO skills (id, tenant_id, pack, category, practice_key, title, current_version, status, approved_version)
      VALUES (${id}, ${tenantId}, 'engineering', ${category}, 'k', ${`Skill for ${category}`}, 1, 'approved', 1)`);
    await tx.execute(sql`
      INSERT INTO skill_versions (tenant_id, skill_id, version, title, body, evidence, gate)
      VALUES (${tenantId}, ${id}, 1, ${`Skill for ${category}`},
              ${JSON.stringify({ when_to_use: "w", preconditions: [], steps: [{ text: "s", evidence: [] }], anti_patterns: [], expected_outcome: "o" })}::jsonb,
              '{"success":[],"failure":[]}', '{}')`);
  });
  return id;
}

/** A judged task in the category, optionally reached through an attributed agent task. */
async function work(
  category: string,
  verdict: "success" | "failure",
  used: { skillId: string; via?: "direct" | "attributed" } | null,
) {
  const id = randomUUID();
  await T(async (tx) => {
    await tx.execute(sql`
      INSERT INTO tasks (id, tenant_id, member_id, source, title_redacted, pack, category, completed_at)
      VALUES (${id}, ${tenantId}, ${member}, 'github', 'PR', 'engineering', ${category}, ${new Date(NOW.getTime() - 86_400_000).toISOString()})`);
    await tx.execute(sql`
      INSERT INTO judgments (id, tenant_id, task_id, pack, ruleset_version, category, verdict, reasons, baseline, input_hash)
      VALUES (${randomUUID()}, ${tenantId}, ${id}, 'engineering', 1, ${category}, ${verdict}, '[]', '{}', repeat('a', 64))`);
    if (!used) return;
    let usedOn = id;
    if (used.via === "attributed") {
      usedOn = randomUUID();
      await tx.execute(sql`
        INSERT INTO tasks (id, tenant_id, member_id, source, title_redacted)
        VALUES (${usedOn}, ${tenantId}, ${member}, 'bridge', 'agent work')`);
      await tx.execute(sql`
        INSERT INTO task_attributions (tenant_id, task_id, target_task_id, method, confidence)
        VALUES (${tenantId}, ${usedOn}, ${id}, 'reference', 1)`);
    }
    await tx.execute(sql`
      INSERT INTO skill_usage (id, tenant_id, skill_id, version, task_id, member_id, used_at)
      VALUES (${randomUUID()}, ${tenantId}, ${used.skillId}, 1, ${usedOn}, ${member}, now())`);
  });
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
  member = await T(
    async (tx) =>
      (
        await memberRepo.ensureMember(tx, tenantId, {
          workosUserId: "m",
          email: "m@acme.test",
          displayName: "M",
        })
      ).member.id,
  );
});

afterAll(async () => {
  await db?.close();
  await env?.stop();
});

describe("measureSkills", () => {
  it("flags a served skill that measurably hurts, once, and tells its reviewers", async () => {
    const id = await skill("bugfix");
    // Followed: 2 of 12 succeed (half reached through an agent task attributed to the PR).
    for (let i = 0; i < 12; i++) {
      await work("bugfix", i < 2 ? "success" : "failure", {
        skillId: id,
        via: i % 2 ? "attributed" : "direct",
      });
    }
    // Not followed: 14 of 18 succeed.
    for (let i = 0; i < 18; i++) await work("bugfix", i < 14 ? "success" : "failure", null);

    const first = await measureSkills({ db, now: () => NOW }, tenantId);
    expect(first.flagged).toEqual([id]);
    const [m] = await T((tx) => tx.select().from(skillMeasurements));
    expect(m).toMatchObject({
      usedN: 12,
      usedSuccess: 2,
      baseN: 18,
      baseSuccess: 14,
      status: "degrades",
    });
    const [s] = await T((tx) =>
      tx
        .select()
        .from(skills)
        .where(sql`id = ${id}`),
    );
    expect(s!.flagReason).toMatch(/succeeded 17% of the time \(12 tasks\), against 78% without it/);
    // Still served: a flag never retires anything by itself.
    expect((await T((tx) => getServedSkill(tx, id))).status).toBe("served");
    const told = await T((tx) =>
      tx
        .select()
        .from(notifications)
        .where(sql`kind = 'skill_flagged'`),
    );
    expect(told.map((n) => n.memberId)).toEqual([admin]);
    expect(
      await T((tx) =>
        tx
          .select()
          .from(auditEvents)
          .where(sql`action = 'skill.flagged'`),
      ),
    ).toHaveLength(1);

    // Same data again: no new measurement row, no second flag.
    expect((await measureSkills({ db, now: () => NOW }, tenantId)).flagged).toEqual([]);
    expect(await T((tx) => tx.select().from(skillMeasurements))).toHaveLength(1);

    // A reviewer keeps it: the flag clears.
    await T((tx) => reviewSkill(tx, tenantId, { skillId: id, memberId: admin, action: "approve" }));
    const [after] = await T((tx) =>
      tx
        .select()
        .from(skills)
        .where(sql`id = ${id}`),
    );
    expect(after!.flaggedAt).toBeNull();
  });

  it("subscriptions pick up served skills per category or whole pack", async () => {
    const a = await skill("feature");
    await skill("refactor");
    await T((tx) =>
      setSubscription(tx, tenantId, {
        memberId: member,
        pack: "engineering",
        category: "feature",
        on: true,
      }),
    );
    expect((await T((tx) => subscribedSkills(tx, member))).map((s) => s.id)).toEqual([a]);
    await T((tx) =>
      setSubscription(tx, tenantId, {
        memberId: member,
        pack: "engineering",
        category: "*",
        on: true,
      }),
    );
    expect((await T((tx) => subscribedSkills(tx, member))).length).toBeGreaterThanOrEqual(3);
  });
});
