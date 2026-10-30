// Cross-tenant isolation suite. It inspects the live catalog, so any table added later
// without tenant isolation (or without seed coverage here) fails the build.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createDb, sql, TenantContextError, type MasterMindDb } from "../src/index.ts";
import { createAgent, revokeAgent } from "../src/repos/agents.ts";
import { addMemberToTeam, ensureMember } from "../src/repos/members.ts";
import { agentKeys, tasks, teamMembers, teams } from "../src/schema.ts";
import { adminQuery, startTestDatabase, type TestDatabase } from "../src/testing.ts";

/** Tables that intentionally hold no tenant data. Each needs a reason, and mm_app must have no access. */
const NON_TENANT_TABLES: Record<string, string> = {
  schema_migrations: "migration bookkeeping, owner-only",
};
/** Tenant tables where RLS is enabled but deliberately not FORCED (see the migration comments). */
const RLS_NOT_FORCED = new Set(["tenants", "agent_keys"]);
/** Tenant tables with a column mm_app must never read (checked below). */
const SECRET_COLUMNS: Record<string, string> = { agent_keys: "key_hash" };
const tenantColumn = (table: string) => (table === "tenants" ? "id" : "tenant_id");

let env: TestDatabase;
let db: MasterMindDb;
interface Seeded {
  tenantId: string;
  teamId: string;
  memberId: string;
  agentId: string;
  agentKey: string;
  taskId: string;
}
let A: Seeded;
let B: Seeded;
let tenantTables: string[];

async function seedTenant(slug: string) {
  const t = await db.system.provisionTenant({
    name: slug.toUpperCase(),
    slug,
    workosOrgId: `org_${slug}`,
    admin: { workosUserId: `user_${slug}_admin`, email: `admin@${slug}.test`, displayName: null },
  });
  return db.withTenant(t.tenantId, async (tx) => {
    const [team] = await tx
      .insert(teams)
      .values({ tenantId: t.tenantId, name: "Platform" })
      .returning();
    const { member } = await ensureMember(tx, t.tenantId, {
      workosUserId: `user_${slug}_dev`,
      email: `dev@${slug}.test`,
      displayName: null,
    });
    await addMemberToTeam(tx, t.tenantId, team!.id, member.id);
    // Rows for every other tenant table, so each one is covered by the read checks.
    await tx.execute(sql`
      INSERT INTO audit_chain_heads (tenant_id, last_seq, last_hash)
      VALUES (${t.tenantId}, 1, ${"a".repeat(64)})`);
    await tx.execute(sql`
      INSERT INTO audit_events (tenant_id, seq, occurred_at, actor_type, action, prev_hash, hash)
      VALUES (${t.tenantId}, 1, now(), 'system', 'tenant.seeded', ${"0".repeat(64)}, ${"a".repeat(64)})`);
    await tx.execute(sql`
      INSERT INTO llm_calls (tenant_id, stage, prompt_id, prompt_version, model, status, latency_ms, input_hash)
      VALUES (${t.tenantId}, 'test', 'seed', 1, 'test-model', 'ok', 1, ${"b".repeat(64)})`);
    const { agent, key } = await createAgent(tx, t.tenantId, {
      memberId: member.id,
      name: "Claude Code",
      kind: "claude_code",
      createdByMemberId: member.id,
    });
    const taskId = crypto.randomUUID();
    const [session] = await tx
      .execute<{ id: string }>(
        sql`
      INSERT INTO agent_sessions (tenant_id, agent_identity_id, member_id, client_session_id)
      VALUES (${t.tenantId}, ${agent.id}, ${member.id}, 'session-1') RETURNING id`,
      )
      .then((r) => r.rows);
    await tx.execute(sql`
      INSERT INTO tasks (id, tenant_id, member_id, agent_identity_id, agent_session_id, source, title_redacted)
      VALUES (${taskId}, ${t.tenantId}, ${member.id}, ${agent.id}, ${session!.id}, 'mcp', 'Seed task')`);
    await tx.execute(sql`
      INSERT INTO artifacts (tenant_id, task_id, kind, content_redacted)
      VALUES (${t.tenantId}, ${taskId}, 'text', 'seed')`);
    await tx.execute(sql`
      INSERT INTO external_refs (tenant_id, task_id, ref)
      VALUES (${t.tenantId}, ${taskId}, ${`github:pr:${slug}/api#1`})`);
    await tx.execute(sql`
      INSERT INTO metric_observations (id, tenant_id, task_id, metric_key, value, source, observed_at)
      VALUES (gen_random_uuid(), ${t.tenantId}, ${taskId}, 'seed.metric', 1, 'mcp', now())`);
    await tx.execute(sql`
      INSERT INTO action_events (tenant_id, id, session_id, member_id, kind, summary_redacted, occurred_at)
      VALUES (${t.tenantId}, gen_random_uuid(), ${session!.id}, ${member.id}, 'edit', 'seed', now())`);
    await tx.execute(sql`
      INSERT INTO lake_outbox (tenant_id, member_id, lake_table, event_id, row)
      VALUES (${t.tenantId}, ${member.id}, 'tasks', ${taskId}, '{}')`);
    await tx.execute(sql`
      INSERT INTO erasure_requests (tenant_id, subject_member_id, requested_by_member_id)
      VALUES (${t.tenantId}, gen_random_uuid(), ${t.adminMemberId})`);
    return {
      tenantId: t.tenantId,
      teamId: team!.id,
      memberId: member.id,
      agentId: agent.id,
      agentKey: key,
      taskId,
    };
  });
}

beforeAll(async () => {
  env = await startTestDatabase();
  // max: 1 forces every call to reuse the same connection, so a leaked context would show.
  db = createDb({ connectionString: env.appUrl, max: 1 });
  A = await seedTenant("alpha");
  B = await seedTenant("bravo");
  const { rows } = await adminQuery<{ relname: string }>(
    env.adminUrl,
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`,
  );
  tenantTables = rows.map((r) => r.relname).filter((t) => !(t in NON_TENANT_TABLES));
});

afterAll(async () => {
  await db?.close();
  await env?.stop();
});

describe("catalog guarantees", () => {
  it("every table has RLS enabled (and forced), a policy, and a tenant key", async () => {
    expect(tenantTables.length).toBeGreaterThan(0);
    const { rows } = await adminQuery<{
      relname: string;
      rls: boolean;
      forced: boolean;
      policies: string;
      has_tenant_col: boolean;
    }>(
      env.adminUrl,
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies,
              EXISTS (SELECT 1 FROM information_schema.columns ic
                      WHERE ic.table_name = c.relname
                        AND ic.column_name = CASE WHEN c.relname = 'tenants' THEN 'id' ELSE 'tenant_id' END
              ) AS has_tenant_col
       FROM pg_class c WHERE c.relname = ANY($1)`,
      [tenantTables],
    );
    for (const r of rows) {
      expect.soft(r.rls, `${r.relname}: RLS enabled`).toBe(true);
      expect.soft(r.forced, `${r.relname}: RLS forced`).toBe(!RLS_NOT_FORCED.has(r.relname));
      expect.soft(Number(r.policies), `${r.relname}: has a policy`).toBeGreaterThan(0);
      expect.soft(r.has_tenant_col, `${r.relname}: has tenant key column`).toBe(true);
    }
  });

  it("non-tenant tables are inaccessible to mm_app", async () => {
    for (const table of Object.keys(NON_TENANT_TABLES)) {
      const { rows } = await adminQuery<{ any_priv: boolean }>(
        env.adminUrl,
        `SELECT has_table_privilege('mm_app', $1, 'SELECT,INSERT,UPDATE,DELETE') AS any_priv`,
        [table],
      );
      expect(rows[0]!.any_priv, table).toBe(false);
    }
  });

  it("mm_app is not superuser, cannot bypass RLS, and owns nothing", async () => {
    const { rows } = await adminQuery<{ rolsuper: boolean; rolbypassrls: boolean; owned: string }>(
      env.adminUrl,
      `SELECT r.rolsuper, r.rolbypassrls,
              (SELECT count(*) FROM pg_class c WHERE c.relowner = r.oid) AS owned
       FROM pg_roles r WHERE r.rolname = 'mm_app'`,
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, owned: "0" });
  });
});

describe("reads", () => {
  it("without tenant context, mm_app sees zero rows in every table", async () => {
    const client = new pg.Client({ connectionString: env.appUrl });
    await client.connect();
    try {
      for (const table of tenantTables) {
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM "${table}"`);
        expect.soft(rows[0].n, table).toBe(0);
      }
    } finally {
      await client.end();
    }
  });

  it("secret columns can't be read by mm_app, even inside its own tenant", async () => {
    for (const [table, column] of Object.entries(SECRET_COLUMNS)) {
      const { rows } = await adminQuery<{ can_select: boolean }>(
        env.adminUrl,
        `SELECT has_column_privilege('mm_app', $1, $2, 'SELECT') AS can_select`,
        [table, column],
      );
      expect(rows[0]!.can_select, `${table}.${column}`).toBe(false);
      await expect(
        db.withTenant(A.tenantId, (tx) => tx.execute(sql.raw(`SELECT ${column} FROM ${table}`))),
      ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "42501" }) });
    }
  });

  it("inside tenant A, every table returns only A's rows (and the seed covers each table)", async () => {
    for (const table of tenantTables) {
      const col = tenantColumn(table);
      const counts = await db.withTenant(A.tenantId, async (tx) => {
        const res = await tx.execute<{ total: number; foreign: number }>(
          sql.raw(`SELECT count(*)::int AS total,
                          count(*) FILTER (WHERE ${col} <> '${A.tenantId}')::int AS foreign
                   FROM "${table}"`),
        );
        return res.rows[0]!;
      });
      expect.soft(counts.foreign, `${table}: rows from another tenant`).toBe(0);
      expect
        .soft(counts.total, `${table}: seed data missing, add it to seedTenant()`)
        .toBeGreaterThan(0);
    }
  });

  it("resolves WorkOS orgs to the right tenant and unknown orgs to null", async () => {
    expect(await db.system.resolveTenantByWorkosOrg("org_alpha")).toBe(A.tenantId);
    expect(await db.system.resolveTenantByWorkosOrg("org_bravo")).toBe(B.tenantId);
    expect(await db.system.resolveTenantByWorkosOrg("org_unknown")).toBeNull();
  });
});

describe("writes from tenant A aimed at tenant B", () => {
  const rlsViolation = { cause: expect.objectContaining({ code: "42501" }) };

  it("cannot insert rows for B", async () => {
    await expect(
      db.withTenant(A.tenantId, (tx) =>
        tx.insert(teams).values({ tenantId: B.tenantId, name: "x" }),
      ),
    ).rejects.toMatchObject(rlsViolation);
  });

  it("cannot move its own rows into B", async () => {
    await expect(
      db.withTenant(A.tenantId, (tx) =>
        tx.execute(sql`UPDATE teams SET tenant_id = ${B.tenantId} WHERE id = ${A.teamId}`),
      ),
    ).rejects.toMatchObject(rlsViolation);
  });

  it("updates and deletes against B's rows affect nothing", async () => {
    const result = await db.withTenant(A.tenantId, async (tx) => {
      const u = await tx.execute(
        sql`UPDATE teams SET name = 'pwned' WHERE tenant_id = ${B.tenantId}`,
      );
      const d = await tx.execute(sql`DELETE FROM members WHERE tenant_id = ${B.tenantId}`);
      return { updated: u.rowCount, deleted: d.rowCount };
    });
    expect(result).toEqual({ updated: 0, deleted: 0 });
    const { rows } = await adminQuery(env.adminUrl, "SELECT name FROM teams WHERE id = $1", [
      B.teamId,
    ]);
    expect(rows[0]!.name).toBe("Platform");
  });

  it("cannot link its team to B's member (composite foreign key)", async () => {
    await expect(
      db.withTenant(A.tenantId, (tx) =>
        tx
          .insert(teamMembers)
          .values({ tenantId: A.tenantId, teamId: A.teamId, memberId: B.memberId }),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "23503" }) });
  });

  it("cannot create or delete tenants directly", async () => {
    await expect(
      db.withTenant(A.tenantId, (tx) =>
        tx.execute(sql`INSERT INTO tenants (name, slug) VALUES ('Evil', 'evil')`),
      ),
    ).rejects.toMatchObject(rlsViolation);
    await expect(
      db.withTenant(A.tenantId, (tx) =>
        tx.execute(sql`DELETE FROM tenants WHERE id = ${A.tenantId}`),
      ),
    ).rejects.toMatchObject(rlsViolation);
  });
});

describe("agent keys", () => {
  it("resolve to the right tenant, agent and member; unknown and malformed keys to null", async () => {
    expect(await db.system.authenticateAgent(A.agentKey)).toEqual({
      tenantId: A.tenantId,
      agentId: A.agentId,
      memberId: A.memberId,
      scopes: ["capture:write", "history:read"],
      captureOptOut: false,
    });
    expect((await db.system.authenticateAgent(B.agentKey))?.tenantId).toBe(B.tenantId);
    const forged = A.agentKey.slice(0, -1) + (A.agentKey.endsWith("a") ? "b" : "a");
    expect(await db.system.authenticateAgent(forged)).toBeNull();
    expect(await db.system.authenticateAgent("mm_live_short")).toBeNull();
    expect(await db.system.authenticateAgent("' OR 1=1 --")).toBeNull();
    // Authentication must not leave a tenant context on the pooled connection.
    expect((await db.health()).leakedTenantContext).toBeNull();
  });

  it("report the member's capture opt-out", async () => {
    await adminQuery(env.adminUrl, "UPDATE members SET capture_opt_out = true WHERE id = $1", [
      A.memberId,
    ]);
    expect((await db.system.authenticateAgent(A.agentKey))?.captureOptOut).toBe(true);
    await adminQuery(env.adminUrl, "UPDATE members SET capture_opt_out = false WHERE id = $1", [
      A.memberId,
    ]);
  });

  it("stop working as soon as they are revoked", async () => {
    const created = await db.withTenant(A.tenantId, (tx) =>
      createAgent(tx, A.tenantId, {
        memberId: A.memberId,
        name: "temp",
        kind: "custom",
        createdByMemberId: A.memberId,
      }),
    );
    expect(await db.system.authenticateAgent(created.key)).not.toBeNull();
    await db.withTenant(A.tenantId, (tx) => revokeAgent(tx, created.agent.id));
    expect(await db.system.authenticateAgent(created.key)).toBeNull();
  });

  it("tenant A cannot register a key for B's agent, or revoke B's agent", async () => {
    await expect(
      db.withTenant(A.tenantId, (tx) =>
        tx.insert(agentKeys).values({
          keyHash: "c".repeat(64),
          tenantId: B.tenantId,
          agentIdentityId: B.agentId,
        }),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "42501" }) });
    expect(await db.withTenant(A.tenantId, (tx) => revokeAgent(tx, B.agentId))).toBeNull();
    expect(await db.system.authenticateAgent(B.agentKey)).not.toBeNull();
  });

  it("tenant A cannot attach a task to B's member or agent (composite foreign keys)", async () => {
    await expect(
      db.withTenant(A.tenantId, (tx) =>
        tx.insert(tasks).values({
          id: crypto.randomUUID(),
          tenantId: A.tenantId,
          memberId: A.memberId,
          agentIdentityId: B.agentId,
          source: "mcp",
          titleRedacted: "x",
        }),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "23503" }) });
  });
});

describe("tenant context handling", () => {
  it("rejects invalid tenant ids before running any query", async () => {
    let ran = false;
    for (const bad of ["", "not-a-uuid", "' OR 1=1 --", undefined as unknown as string]) {
      await expect(
        db.withTenant(bad, async () => {
          ran = true;
        }),
      ).rejects.toBeInstanceOf(TenantContextError);
    }
    expect(ran).toBe(false);
  });

  it("context never leaks to the next use of a pooled connection", async () => {
    await db.withTenant(A.tenantId, async () => {});
    expect((await db.health()).leakedTenantContext).toBeNull();
    const seen = await db.withTenant(B.tenantId, async (tx) => {
      const res = await tx.execute<{ t: string }>(sql`SELECT mm_current_tenant()::text AS t`);
      return res.rows[0]!.t;
    });
    expect(seen).toBe(B.tenantId);
    expect((await db.health()).leakedTenantContext).toBeNull();
  });

  it("rolls back everything when the callback throws", async () => {
    await expect(
      db.withTenant(A.tenantId, async (tx) => {
        await tx.insert(teams).values({ tenantId: A.tenantId, name: "Doomed" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const { rows } = await adminQuery(env.adminUrl, "SELECT 1 FROM teams WHERE name = 'Doomed'");
    expect(rows).toHaveLength(0);
  });
});
