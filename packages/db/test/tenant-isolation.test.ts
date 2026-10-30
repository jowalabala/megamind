// Cross-tenant isolation suite. It inspects the live catalog, so any table added later
// without tenant isolation (or without seed coverage here) fails the build.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createDb, sql, TenantContextError, type MasterMindDb } from "../src/index.ts";
import { addMemberToTeam, ensureMember } from "../src/repos/members.ts";
import { teamMembers, teams } from "../src/schema.ts";
import { adminQuery, startTestDatabase, type TestDatabase } from "../src/testing.ts";

/** Tables that intentionally hold no tenant data. Each needs a reason, and mm_app must have no access. */
const NON_TENANT_TABLES: Record<string, string> = {
  schema_migrations: "migration bookkeeping, owner-only",
};
/** Tenant tables where RLS is enabled but deliberately not FORCED (see the migration comment). */
const RLS_NOT_FORCED = new Set(["tenants"]);
const tenantColumn = (table: string) => (table === "tenants" ? "id" : "tenant_id");

let env: TestDatabase;
let db: MasterMindDb;
let A: { tenantId: string; teamId: string; memberId: string };
let B: { tenantId: string; teamId: string; memberId: string };
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
    return { tenantId: t.tenantId, teamId: team!.id, memberId: member.id };
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
