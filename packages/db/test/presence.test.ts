// Live presence: who sees whom, private sessions, opt-outs, and expiry.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type MasterMindDb } from "../src/client.ts";
import { agentRepo, memberRepo, presenceRepo, sql, teams } from "../src/index.ts";
import { adminQuery, startTestDatabase, type TestDatabase } from "../src/testing.ts";

let env: TestDatabase;
let db: MasterMindDb;
let tenantId: string;
const people: Record<string, { memberId: string; agentId: string }> = {};

async function person(
  name: string,
  team: string | null,
  opts: { pref?: string; optOut?: boolean } = {},
) {
  people[name] = await db.withTenant(tenantId, async (tx) => {
    const { member } = await memberRepo.ensureMember(tx, tenantId, {
      workosUserId: `u_${randomUUID()}`,
      email: `${name.toLowerCase().replace(/ /g, ".")}@acme.test`,
      displayName: name,
    });
    await tx.execute(sql`UPDATE members SET visibility_pref = ${opts.pref ?? "name"},
      capture_opt_out = ${opts.optOut ?? false} WHERE id = ${member.id}`);
    if (team) {
      const [t] = await tx
        .select()
        .from(teams)
        .where(sql`name = ${team}`);
      const teamId =
        t?.id ?? (await tx.insert(teams).values({ tenantId, name: team }).returning())[0]!.id;
      await memberRepo.addMemberToTeam(tx, tenantId, teamId, member.id);
    }
    const { agent } = await agentRepo.createAgent(tx, tenantId, {
      memberId: member.id,
      name: "cc",
      kind: "claude_code",
      createdByMemberId: member.id,
    });
    return { memberId: member.id, agentId: agent.id };
  });
}

const join = (name: string, session: string, opts: { private?: boolean } = {}) =>
  db.withTenant(tenantId, (tx) =>
    presenceRepo.upsertLiveSession(tx, tenantId, {
      agentId: people[name]!.agentId,
      memberId: people[name]!.memberId,
      clientSessionId: session,
      context: { tool: "claude_code", repo: "github.com/acme/api", branch: `${session}-branch` },
      private: opts.private ?? false,
    }),
  );
const view = (name: string) =>
  db.withTenant(tenantId, (tx) => presenceRepo.liveSessions(tx, people[name]!.memberId));

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
  await person("Dana Levi", "Platform");
  await person("Lior Cohen", "Platform");
  await person("Sam Patel", "Sales");
  await person("Anon Person", "Platform", { pref: "anonymous" });
  await person("Quiet Person", "Platform", { optOut: true });
});

afterAll(async () => {
  await db?.close();
  await env?.stop();
});

describe("liveSessions", () => {
  it("applies the visibility rules", async () => {
    await join("Dana Levi", "dana-1");
    await join("Lior Cohen", "lior-1");
    await join("Sam Patel", "sam-1");
    await join("Anon Person", "anon-1");
    await join("Quiet Person", "quiet-1");
    await join("Lior Cohen", "lior-secret", { private: true });

    const asDana = await view("Dana Levi");
    expect(asDana.map((s) => [s.who, s.branch])).toEqual([
      ["you", "dana-1-branch"],
      ["Lior Cohen", "lior-1-branch"],
      // Other team: team name only, and no branch.
      ["someone on Sales", null],
      ["a teammate", "anon-1-branch"],
    ]);
    // Lior sees their own private session.
    expect((await view("Lior Cohen")).filter((s) => s.you)).toHaveLength(2);
    // Opted-out members see themselves; nobody else sees them.
    expect((await view("Quiet Person")).some((s) => s.you)).toBe(true);
  });

  it("drops sessions that stopped sending heartbeats, and ended ones", async () => {
    const { id } = await join("Sam Patel", "sam-old");
    await adminQuery(
      env.adminUrl,
      `UPDATE agent_sessions SET last_heartbeat_at = now() - interval '2 minutes' WHERE id = $1`,
      [id],
    );
    expect((await view("Dana Levi")).some((s) => s.session_id === id)).toBe(false);
    await db.withTenant(tenantId, (tx) => presenceRepo.heartbeat(tx, id));
    expect((await view("Dana Levi")).some((s) => s.session_id === id)).toBe(true);
    await db.withTenant(tenantId, (tx) => presenceRepo.endSession(tx, id));
    expect((await view("Dana Levi")).some((s) => s.session_id === id)).toBe(false);
  });

  it("a session marked private stays private when it reconnects", async () => {
    const first = await join("Dana Levi", "dana-private", { private: true });
    const again = await join("Dana Levi", "dana-private", { private: false });
    expect(again).toEqual({ id: first.id, private: true });
  });
});
