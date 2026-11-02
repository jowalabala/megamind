// Operator-only operations that need the migration (owner) role, e.g. from onboarding CLIs.
// Never used by the running services, which only hold mm_app credentials.
import pg from "pg";
import { assertTenantId } from "./client.ts";

/** Marks a tenant's lake as provisioned, so the worker starts publishing its rows. */
export async function markTenantLakeReady(adminUrl: string, tenantId: string): Promise<boolean> {
  assertTenantId(tenantId);
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const res = await client.query(
      "UPDATE tenants SET lake_ready_at = coalesce(lake_ready_at, now()) WHERE id = $1",
      [tenantId],
    );
    return res.rowCount === 1;
  } finally {
    await client.end();
  }
}

async function withAdmin<T>(adminUrl: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export interface TenantDeletionState {
  tenantId: string;
  status: "scheduled" | "cancelled" | "purging" | "purged";
  purgeAfter: Date;
  steps: Record<string, string>;
  /** Null once the tenant row itself is gone. */
  workosOrgId: string | null;
}

/** The deletion record of a tenant, read as the owner (it outlives the tenant). */
export async function readTenantDeletion(
  adminUrl: string,
  tenantId: string,
): Promise<TenantDeletionState | null> {
  assertTenantId(tenantId);
  return withAdmin(adminUrl, async (c) => {
    await c.query("BEGIN");
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const res = await c.query<{
        status: TenantDeletionState["status"];
        purge_after: Date;
        steps: Record<string, string>;
        workos_org_id: string | null;
      }>(
        `SELECT d.status, d.purge_after, d.steps, t.workos_org_id
           FROM tenant_deletions d LEFT JOIN tenants t ON t.id = d.tenant_id
          WHERE d.tenant_id = $1`,
        [tenantId],
      );
      await c.query("COMMIT");
      const r = res.rows[0];
      return r
        ? {
            tenantId,
            status: r.status,
            purgeAfter: r.purge_after,
            steps: r.steps,
            workosOrgId: r.workos_org_id,
          }
        : null;
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  });
}

/** Records one finished purge step (and marks the deletion purging). */
export async function markTenantDeletionStep(
  adminUrl: string,
  tenantId: string,
  step: string,
  done = false,
): Promise<void> {
  assertTenantId(tenantId);
  if (!/^[a-z_]{1,40}$/.test(step)) throw new Error("Invalid step name");
  await withAdmin(adminUrl, async (c) => {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await c.query(
      `UPDATE tenant_deletions
          SET steps = steps || jsonb_build_object($2::text, now()),
              status = CASE WHEN $3 THEN 'purged' ELSE 'purging' END,
              purged_at = CASE WHEN $3 THEN now() ELSE purged_at END,
              updated_at = now()
        WHERE tenant_id = $1 AND status IN ('scheduled', 'purging')`,
      [tenantId, step, done],
    );
    await c.query("COMMIT");
  });
}

/** Deletes every Postgres row of a tenant except its deletion record. Returns counts per table. */
export async function purgeTenantRows(
  adminUrl: string,
  tenantId: string,
): Promise<Record<string, number>> {
  assertTenantId(tenantId);
  return withAdmin(adminUrl, async (c) => {
    await c.query("BEGIN");
    try {
      const res = await c.query<{ counts: Record<string, number> }>(
        "SELECT mm_purge_tenant($1) AS counts",
        [tenantId],
      );
      await c.query("COMMIT");
      return res.rows[0]!.counts;
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  });
}

/** Every public table's rows for a tenant (except the deletion record). For purge checks. */
export async function tenantRowCounts(
  adminUrl: string,
  tenantId: string,
): Promise<Record<string, number>> {
  assertTenantId(tenantId);
  return withAdmin(adminUrl, async (c) => {
    await c.query("BEGIN");
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const tables = await c.query<{ table_name: string; col: string }>(
        `SELECT c.table_name, c.column_name AS col FROM information_schema.columns c
           JOIN information_schema.tables t
             ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
            AND ((c.column_name = 'tenant_id' AND c.table_name <> 'tenant_deletions')
                 OR (c.table_name = 'tenants' AND c.column_name = 'id'))`,
      );
      const out: Record<string, number> = {};
      for (const t of tables.rows) {
        const r = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "${t.table_name}" WHERE "${t.col}" = $1`,
          [tenantId],
        );
        out[t.table_name] = r.rows[0]!.n;
      }
      await c.query("COMMIT");
      return out;
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  });
}

/** A tenant's sealed connector tokens, read as the owner (for revocation at purge time). */
export async function readSealedConnectorSecrets(
  adminUrl: string,
  tenantId: string,
): Promise<{ provider: string; connectionId: string; kind: string; sealed: string }[]> {
  assertTenantId(tenantId);
  return withAdmin(adminUrl, async (c) => {
    await c.query("BEGIN");
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const res = await c.query<{
        provider: string;
        connection_id: string;
        kind: string;
        sealed: string;
      }>(
        `SELECT c.provider, s.connection_id, s.kind, s.sealed
           FROM connection_secrets s
           JOIN connections c ON c.tenant_id = s.tenant_id AND c.id = s.connection_id
          WHERE s.tenant_id = $1`,
        [tenantId],
      );
      await c.query("COMMIT");
      return res.rows.map((r) => ({
        provider: r.provider,
        connectionId: r.connection_id,
        kind: r.kind,
        sealed: r.sealed,
      }));
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  });
}

/** Applied migrations and tenant ids, read as the owner (restore drills). */
export async function readDatabaseState(
  adminUrl: string,
): Promise<{ migrations: string[]; tenantIds: string[] }> {
  return withAdmin(adminUrl, async (c) => {
    const m = await c.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
    const t = await c.query<{ id: string }>("SELECT id FROM tenants ORDER BY created_at");
    return { migrations: m.rows.map((r) => r.name), tenantIds: t.rows.map((r) => r.id) };
  });
}
