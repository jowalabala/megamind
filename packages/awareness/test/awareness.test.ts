import { randomUUID } from "node:crypto";
import { agentRepo, createDb, memberRepo, sql, teams, type MasterMindDb } from "@mm/db";
import { startTestDatabase, type TestDatabase } from "@mm/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  alertsFor,
  describeAlert,
  detectOverlaps,
  markDelivered,
  normalizeResource,
  parseResource,
  rangesIntersect,
  similarity,
} from "../src/index.ts";

describe("resource keys", () => {
  it("normalize the same file to the same key", () => {
    expect(parseResource("git:GitHub.com/Acme/API.git:./src//billing/invoice.ts#L40-80")).toEqual({
      base: "git:github.com/acme/api:src/billing/invoice.ts",
      repo: "github.com/acme/api",
      lines: [[40, 80]],
    });
    expect(normalizeResource("HubSpot:List:123")).toBe("hubspot:list:123");
    expect(parseResource("git:x/y:../etc/passwd")).toBeNull();
    expect(parseResource("not a key")).toBeNull();
    expect(parseResource("git:a/b:f.ts#L9-3")!.lines).toEqual([]);
  });

  it("intersect line ranges and score intent similarity", () => {
    expect(
      rangesIntersect(
        [
          [10, 20],
          [40, 50],
        ],
        [[15, 45]],
      ),
    ).toEqual([
      [15, 20],
      [40, 45],
    ]);
    expect(rangesIntersect([[1, 5]], [[6, 9]])).toEqual([]);
    expect(
      similarity("Add proration to invoice totals", "Proration for invoice totals on upgrade"),
    ).toBeGreaterThan(0.4);
    expect(similarity("Add proration to invoice totals", "Fix flaky login test")).toBe(0);
  });
});

let env: TestDatabase;
let db: MasterMindDb;
let tenantId: string;
const people: Record<string, { memberId: string; agentId: string }> = {};

async function person(name: string, team: string) {
  people[name] = await db.withTenant(tenantId, async (tx) => {
    const { member } = await memberRepo.ensureMember(tx, tenantId, {
      workosUserId: `u_${randomUUID()}`,
      email: `${name.toLowerCase()}@acme.test`,
      displayName: name,
    });
    await tx.execute(sql`UPDATE members SET visibility_pref = 'name' WHERE id = ${member.id}`);
    const [t] = await tx
      .select()
      .from(teams)
      .where(sql`name = ${team}`);
    const teamId =
      t?.id ?? (await tx.insert(teams).values({ tenantId, name: team }).returning())[0]!.id;
    await memberRepo.addMemberToTeam(tx, tenantId, teamId, member.id);
    const { agent } = await agentRepo.createAgent(tx, tenantId, {
      memberId: member.id,
      name: "cc",
      kind: "claude_code",
      createdByMemberId: member.id,
    });
    return { memberId: member.id, agentId: agent.id };
  });
}

async function session(name: string, opts: { private?: boolean; repo?: string } = {}) {
  const p = people[name]!;
  return db.withTenant(
    tenantId,
    async (tx) =>
      (
        await tx.execute<{ id: string }>(sql`
        INSERT INTO agent_sessions (tenant_id, agent_identity_id, member_id, client_session_id, private, context_redacted)
        VALUES (${tenantId}, ${p.agentId}, ${p.memberId}, ${randomUUID()}, ${opts.private ?? false},
                ${JSON.stringify({ repo: opts.repo ?? "github.com/acme/api" })}::jsonb)
        RETURNING id`)
      ).rows[0]!.id,
  );
}

async function touch(name: string, sessionId: string, resources: string[]) {
  await db.withTenant(tenantId, (tx) =>
    tx.execute(sql`
      INSERT INTO action_events (tenant_id, id, session_id, member_id, kind, summary_redacted, resources, occurred_at)
      VALUES (${tenantId}, gen_random_uuid(), ${sessionId}, ${people[name]!.memberId}, 'edit', 'edit',
              ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(resources)}::jsonb)), now())`),
  );
}

async function intent(name: string, sessionId: string, description: string) {
  await db.withTenant(tenantId, (tx) =>
    tx.execute(sql`
      INSERT INTO intents (id, tenant_id, session_id, member_id, description_redacted)
      VALUES (gen_random_uuid(), ${tenantId}, ${sessionId}, ${people[name]!.memberId}, ${description})`),
  );
}

const detect = (s: string) => db.withTenant(tenantId, (tx) => detectOverlaps(tx, tenantId, s));
const alerts = (name: string, s: string, undelivered = true) =>
  db.withTenant(tenantId, (tx) => alertsFor(tx, s, people[name]!.memberId, { undelivered }));

beforeAll(async () => {
  env = await startTestDatabase();
  db = createDb({ connectionString: env.appUrl });
  tenantId = (
    await db.system.provisionTenant({
      name: "Acme",
      slug: "acme",
      workosOrgId: "org_acme",
      admin: { workosUserId: "admin", email: "admin@acme.test", displayName: null },
    })
  ).tenantId;
  await person("Dana", "Platform");
  await person("Lior", "Platform");
  await person("Sam", "Sales");
});

afterAll(async () => {
  await db?.close();
  await env?.stop();
});

describe("detectOverlaps", () => {
  it("finds same lines (high), alerts each side once, and from each side's view", async () => {
    const dana = await session("Dana");
    const lior = await session("Lior");
    await touch("Dana", dana, ["git:github.com/acme/api:src/billing/invoice.ts#L40-80"]);
    await touch("Lior", lior, ["git:github.com/Acme/API:./src/billing/invoice.ts#L55-90"]);
    const found = await detect(lior);
    expect(found.map((f) => [f.kind, f.isNew])).toEqual([["same_lines", true]]);

    const forDana = await alerts("Dana", dana);
    expect(forDana).toHaveLength(1);
    expect(forDana[0]).toMatchObject({
      kind: "same_lines",
      severity: "high",
      with: "Lior",
      your_lines: [[40, 80]],
      their_lines: [[55, 90]],
      shared_lines: [[55, 80]],
    });
    expect(describeAlert(forDana[0]!)).toBe(
      "Conflict likely: Lior is changing the same lines of git:github.com/acme/api:src/billing/invoice.ts (lines 55-80).",
    );
    await db.withTenant(tenantId, (tx) =>
      markDelivered(
        tx,
        dana,
        forDana.map((a) => a.id),
      ),
    );
    expect(await alerts("Dana", dana)).toEqual([]);
    // Lior's side is still pending until delivered to Lior.
    expect(await alerts("Lior", lior)).toHaveLength(1);
    // Seeing it again is not new.
    expect((await detect(dana)).every((f) => !f.isNew)).toBe(true);
  });

  it("same file, different lines: a heads-up; other teams see a team, not a name", async () => {
    const dana = await session("Dana");
    const sam = await session("Sam");
    await touch("Dana", dana, ["git:github.com/acme/api:src/tax.ts#L1-10"]);
    await touch("Sam", sam, ["git:github.com/acme/api:src/tax.ts#L100-120"]);
    await detect(sam);
    const forDana = await alerts("Dana", dana);
    expect(forDana.map((a) => [a.kind, a.severity, a.with])).toEqual([
      ["same_resource", "medium", "someone on Sales"],
    ]);
  });

  it("ignores private sessions and a person's own other sessions", async () => {
    const dana = await session("Dana");
    const danaOther = await session("Dana");
    const secret = await session("Lior", { private: true });
    for (const [n, s] of [
      ["Dana", dana],
      ["Dana", danaOther],
      ["Lior", secret],
    ] as const) {
      await touch(n, s, ["git:github.com/acme/api:src/ledger.ts#L1-50"]);
    }
    expect(await detect(dana)).toEqual([]);
    expect(await detect(secret)).toEqual([]);
  });

  it("flags related work from similar intents in the same repository", async () => {
    const a = await session("Lior", { repo: "github.com/acme/web" });
    const b = await session("Sam", { repo: "github.com/acme/web" });
    await intent("Lior", a, "Add dark mode toggle to the settings page");
    await intent("Sam", b, "Dark mode for settings page and toggle styling");
    const found = await detect(b);
    expect(found.map((f) => f.kind)).toEqual(["related_work"]);
    expect((await alerts("Lior", a))[0]).toMatchObject({ kind: "related_work", severity: "low" });
  });
});
