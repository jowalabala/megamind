// History search visibility rules, hot-index pruning and member erasure.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type MasterMindDb, type TenantTx } from "../src/client.ts";
import { createAgent } from "../src/repos/agents.ts";
import {
  dueErasureRequests,
  ErasureNotAllowedError,
  requestMemberErasure,
} from "../src/repos/erasure.ts";
import { pruneHotActions, searchHistory } from "../src/repos/history.ts";
import { addMemberToTeam, ensureMember } from "../src/repos/members.ts";
import { sql, teams } from "../src/index.ts";
import { startTestDatabase, type TestDatabase } from "../src/testing.ts";

let env: TestDatabase;
let db: MasterMindDb;

interface Person {
  id: string;
  sessionId: string;
  privateSessionId: string;
}

async function person(
  tx: TenantTx,
  tenantId: string,
  name: string,
  opts: { team?: string; pref?: "name" | "team" | "anonymous"; optOut?: boolean } = {},
): Promise<Person> {
  const slug = name.toLowerCase().replace(/\W+/g, "");
  const { member } = await ensureMember(tx, tenantId, {
    workosUserId: `user_${slug}_${randomUUID()}`,
    email: `${slug}@acme.test`,
    displayName: name,
  });
  await tx.execute(sql`
    UPDATE members SET visibility_pref = ${opts.pref ?? "name"}, capture_opt_out = ${opts.optOut ?? false}
     WHERE id = ${member.id}`);
  if (opts.team) {
    const [team] = await tx
      .select()
      .from(teams)
      .where(sql`name = ${opts.team}`);
    const teamId =
      team?.id ?? (await tx.insert(teams).values({ tenantId, name: opts.team }).returning())[0]!.id;
    await addMemberToTeam(tx, tenantId, teamId, member.id);
  }
  const { agent } = await createAgent(tx, tenantId, {
    memberId: member.id,
    name: "Claude Code",
    kind: "claude_code",
    createdByMemberId: member.id,
  });
  const session = async (priv: boolean) =>
    (
      await tx.execute<{ id: string }>(sql`
        INSERT INTO agent_sessions (tenant_id, agent_identity_id, member_id, client_session_id, private)
        VALUES (${tenantId}, ${agent.id}, ${member.id}, ${randomUUID()}, ${priv}) RETURNING id`)
    ).rows[0]!.id;
  return { id: member.id, sessionId: await session(false), privateSessionId: await session(true) };
}

async function task(
  tx: TenantTx,
  tenantId: string,
  p: Person,
  title: string,
  opts: { private?: boolean; refs?: string[]; at?: string } = {},
) {
  const id = randomUUID();
  await tx.execute(sql`
    INSERT INTO tasks (id, tenant_id, member_id, agent_session_id, source, title_redacted, summary_redacted, created_at)
    VALUES (${id}, ${tenantId}, ${p.id}, ${opts.private ? p.privateSessionId : p.sessionId}, 'mcp',
            ${title}, ${`Summary of ${title}`}, ${opts.at ?? new Date().toISOString()})`);
  for (const ref of opts.refs ?? []) {
    await tx.execute(
      sql`INSERT INTO external_refs (tenant_id, task_id, ref) VALUES (${tenantId}, ${id}, ${ref})`,
    );
  }
  return id;
}

async function action(
  tx: TenantTx,
  tenantId: string,
  p: Person,
  summary: string,
  resources: string[],
  opts: { private?: boolean; taskId?: string; at?: string } = {},
) {
  const id = randomUUID();
  await tx.execute(sql`
    INSERT INTO action_events (tenant_id, id, session_id, member_id, task_id, kind, summary_redacted, resources, occurred_at)
    VALUES (${tenantId}, ${id}, ${opts.private ? p.privateSessionId : p.sessionId}, ${p.id},
            ${opts.taskId ?? null}, 'edit', ${summary},
            ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(resources)}::jsonb)),
            ${opts.at ?? new Date().toISOString()})`);
  return id;
}

let A: string;
let B: string;
let admin: string;
let me: Person;
let dana: Person;
let lior: Person;
let sam: Person;
let quiet: Person;
let loner: Person;
let prorationTask: string;

beforeAll(async () => {
  env = await startTestDatabase();
  db = createDb({ connectionString: env.appUrl });
  const a = await db.system.provisionTenant({
    name: "Acme",
    slug: "acme",
    workosOrgId: "org_acme",
    admin: { workosUserId: "user_admin", email: "admin@acme.test", displayName: "Admin" },
  });
  A = a.tenantId;
  admin = a.adminMemberId;
  B = (
    await db.system.provisionTenant({
      name: "Beta",
      slug: "beta",
      workosOrgId: "org_beta",
      admin: { workosUserId: "user_b", email: "admin@beta.test", displayName: null },
    })
  ).tenantId;

  await db.withTenant(A, async (tx) => {
    me = await person(tx, A, "Me Myself", { team: "Platform" });
    dana = await person(tx, A, "Dana Levi", { team: "Platform" });
    lior = await person(tx, A, "Lior Cohen", { team: "Platform", pref: "anonymous" });
    sam = await person(tx, A, "Sam Patel", { team: "Sales" });
    quiet = await person(tx, A, "Quiet Person", { team: "Platform", optOut: true });
    loner = await person(tx, A, "No Team", {});

    prorationTask = await task(tx, A, dana, "Add proration to billing", {
      refs: ["github:pr:acme/api#12"],
    });
    await tx.execute(sql`
      INSERT INTO metric_observations (id, tenant_id, task_id, metric_key, value, source, observed_at)
      VALUES (gen_random_uuid(), ${A}, ${prorationTask}, 'ci.first_pass', 0, 'mcp', now() - interval '1 hour'),
             (gen_random_uuid(), ${A}, ${prorationTask}, 'ci.first_pass', 1, 'mcp', now())`);
    await action(
      tx,
      A,
      dana,
      "Edited invoice totals for proration",
      ["git:github.com/acme/api:src/billing/invoice.ts#L40-80"],
      { taskId: prorationTask },
    );
    await task(tx, A, lior, "Billing tax lines");
    await task(tx, A, sam, "Billing email campaign");
    await task(tx, A, quiet, "Billing secret project");
    await task(tx, A, dana, "Billing private experiment", { private: true });
    await task(tx, A, me, "My billing cleanup");
    await task(tx, A, loner, "Billing from someone without a team");
  });
  await db.withTenant(B, async (tx) => {
    const other = await person(tx, B, "Other Tenant", {});
    await task(tx, B, other, "Billing in another company");
  });
});

afterAll(async () => {
  await db?.close();
  await env?.stop();
});

const search = (q: Parameters<typeof searchHistory>[1]) =>
  db.withTenant(A, (tx) => searchHistory(tx, q));

describe("searchHistory", () => {
  it("applies visibility: hides private sessions and opted-out members, labels authors by preference", async () => {
    const items = await search({ requesterMemberId: me.id, text: "billing", limit: 25 });
    const byTitle = Object.fromEntries(
      items.filter((i) => i.type === "task").map((i) => [i.title, i.who]),
    );
    expect(byTitle).toEqual({
      "Add proration to billing": "Dana Levi",
      "Billing tax lines": "a teammate",
      "Billing email campaign": "someone on Sales",
      "My billing cleanup": "you",
      // Neither shares a team with the other, so only "a teammate" (no team name to show).
      "Billing from someone without a team": "a teammate",
    });
  });

  it("shows members their own private and opted-out items", async () => {
    const asDana = await search({ requesterMemberId: dana.id, text: "private experiment" });
    expect(asDana.map((i) => i.title)).toContain("Billing private experiment");
    const asQuiet = await search({ requesterMemberId: quiet.id, text: "secret project" });
    expect(asQuiet.map((i) => [i.title, i.who])).toEqual([["Billing secret project", "you"]]);
  });

  it("members without teams see each other's names", async () => {
    const lonerTwo = await db.withTenant(A, (tx) => person(tx, A, "Also Alone", {}));
    const items = await search({ requesterMemberId: lonerTwo.id, text: "without a team" });
    expect(items[0]?.who).toBe("No Team");
  });

  it("filters by resource across action resources, task refs and linked actions", async () => {
    const items = await search({ requesterMemberId: me.id, resource: "src/billing/" });
    expect(items.map((i) => i.type).sort()).toEqual(["action", "task"]);
    const t = items.find((i) => i.type === "task")!;
    expect(t.id).toBe(prorationTask);
    expect(t.resources).toEqual(["github:pr:acme/api#12"]);
    // Latest observation per metric.
    expect(t.outcomes).toEqual([{ metric: "ci.first_pass", value: 1, n: 1 }]);

    const byRef = await search({ requesterMemberId: me.id, resource: "acme/api#12" });
    expect(byRef.map((i) => i.id)).toEqual([prorationTask]);
    // LIKE wildcards in the input are literal.
    expect(await search({ requesterMemberId: me.id, resource: "%" })).toEqual([]);
  });

  it("respects kinds, time bounds and the limit", async () => {
    const actions = await search({
      requesterMemberId: me.id,
      text: "proration",
      kinds: ["actions"],
    });
    expect(actions.every((i) => i.type === "action")).toBe(true);
    expect(actions).toHaveLength(1);
    const future = await search({
      requesterMemberId: me.id,
      text: "billing",
      since: new Date(Date.now() + 60_000),
    });
    expect(future).toEqual([]);
    expect(await search({ requesterMemberId: me.id, text: "billing", limit: 2 })).toHaveLength(2);
  });

  it("never returns another tenant's rows", async () => {
    const items = await search({ requesterMemberId: me.id, text: "another company" });
    expect(items).toEqual([]);
  });

  it("rejects an empty query", async () => {
    await expect(search({ requesterMemberId: me.id, text: "  " })).rejects.toThrow(
      /text or a resource/,
    );
  });
});

describe("background job helpers", () => {
  it("lists every tenant with its lake readiness", async () => {
    const tenants = await db.system.listTenantsForJobs();
    expect(tenants.map((t) => t.tenantId).sort()).toEqual([A, B].sort());
    expect(tenants.every((t) => t.lakeReady === false)).toBe(true);
  });

  it("prunes hot actions past the retention window only", async () => {
    const old = await db.withTenant(A, (tx) =>
      action(tx, A, sam, "Ancient edit", ["tag:sales:old"], {
        at: new Date(Date.now() - 100 * 86_400_000).toISOString(),
      }),
    );
    const removed = await db.withTenant(A, (tx) => pruneHotActions(tx, 90));
    expect(removed).toBe(1);
    const left = await db.withTenant(A, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM action_events WHERE id = ${old}`),
    );
    expect(left.rows[0]!.n).toBe(0);
  });
});

describe("member erasure", () => {
  it("deletes the member and everything they captured, and queues the lake and bronze work", async () => {
    const victim = await db.withTenant(A, async (tx) => {
      const p = await person(tx, A, "Leaving Soon", { team: "Platform" });
      const t = await task(tx, A, p, "Leaving soon task");
      await action(tx, A, p, "Leaving soon edit", [], { taskId: t });
      await tx.execute(sql`
        INSERT INTO lake_outbox (tenant_id, member_id, lake_table, event_id, row)
        VALUES (${A}, ${p.id}, 'tasks', ${t}, '{}')`);
      return p;
    });
    const request = await db.withTenant(A, (tx) =>
      requestMemberErasure(tx, A, { subjectMemberId: victim.id, requestedByMemberId: admin }),
    );
    expect(request.status).toBe("pending");

    const counts = await db.withTenant(A, (tx) =>
      tx.execute<Record<string, number>>(sql`
        SELECT (SELECT count(*) FROM members WHERE id = ${victim.id})::int AS members,
               (SELECT count(*) FROM tasks WHERE member_id = ${victim.id})::int AS tasks,
               (SELECT count(*) FROM action_events WHERE member_id = ${victim.id})::int AS actions,
               (SELECT count(*) FROM agent_identities WHERE member_id = ${victim.id})::int AS agents,
               (SELECT count(*) FROM agent_sessions WHERE member_id = ${victim.id})::int AS sessions,
               (SELECT count(*) FROM lake_outbox WHERE member_id = ${victim.id})::int AS outbox`),
    );
    expect(counts.rows[0]).toEqual({
      members: 0,
      tasks: 0,
      actions: 0,
      agents: 0,
      sessions: 0,
      outbox: 0,
    });
    const due = await db.withTenant(A, (tx) => dueErasureRequests(tx));
    expect(due.map((r) => r.subjectMemberId)).toContain(victim.id);
  });

  it("refuses self-erasure and unknown members", async () => {
    await expect(
      db.withTenant(A, (tx) =>
        requestMemberErasure(tx, A, { subjectMemberId: admin, requestedByMemberId: admin }),
      ),
    ).rejects.toBeInstanceOf(ErasureNotAllowedError);
    await expect(
      db.withTenant(A, (tx) =>
        requestMemberErasure(tx, A, { subjectMemberId: randomUUID(), requestedByMemberId: admin }),
      ),
    ).rejects.toBeInstanceOf(ErasureNotAllowedError);
  });

  it("can't erase a member of another tenant", async () => {
    const outsider = await db.withTenant(B, (tx) => person(tx, B, "Beta Person", {}));
    await expect(
      db.withTenant(A, (tx) =>
        requestMemberErasure(tx, A, { subjectMemberId: outsider.id, requestedByMemberId: admin }),
      ),
    ).rejects.toBeInstanceOf(ErasureNotAllowedError);
  });
});
