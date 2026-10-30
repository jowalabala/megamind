import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { AGENT_KEY_RE, hashAgentKey } from "./repos/agents.ts";
import * as schema from "./schema.ts";
import type { AgentScope } from "./schema.ts";

export type Database = NodePgDatabase<typeof schema>;
/** A transaction that already has a tenant context set. All tenant data access goes through one. */
export type TenantTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantContextError extends Error {
  override name = "TenantContextError";
}

export function assertTenantId(tenantId: unknown): asserts tenantId is string {
  if (typeof tenantId !== "string" || !UUID_RE.test(tenantId)) {
    throw new TenantContextError("A valid tenant id is required for tenant-scoped access.");
  }
}

export interface ProvisionTenantInput {
  name: string;
  slug: string;
  workosOrgId: string | null;
  admin: { workosUserId: string; email: string; displayName: string | null };
}

export interface ProvisionedTenant {
  tenantId: string;
  adminMemberId: string;
}

export interface AuthenticatedAgent {
  tenantId: string;
  agentId: string;
  memberId: string;
  scopes: AgentScope[];
  /** The member opted out of capture: drop their data before storing anything. */
  captureOptOut: boolean;
}

export interface MasterMindDb {
  /**
   * Runs `fn` in a transaction scoped to one tenant. Row-level security limits every
   * query inside it to that tenant. The context is transaction-local and is gone once
   * this returns.
   */
  withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T>;
  /** Control-plane operations that run before a tenant context exists. */
  system: {
    /**
     * Creates a tenant and its admin member. `inTx` runs in the same transaction with the
     * new tenant's context set (use it to write the audit event atomically).
     */
    provisionTenant(
      input: ProvisionTenantInput,
      inTx?: (tx: TenantTx, tenant: ProvisionedTenant) => Promise<void>,
    ): Promise<ProvisionedTenant>;
    /** Resolves a verified WorkOS organization id to a tenant id, or null. */
    resolveTenantByWorkosOrg(workosOrgId: string): Promise<string | null>;
    /** Resolves an agent API key. Null for malformed, unknown or revoked keys. */
    authenticateAgent(key: string): Promise<AuthenticatedAgent | null>;
    /**
     * Every tenant id, for background jobs that then work inside each tenant's context.
     * `lakeReady` is true once the tenant's lake namespace has been provisioned.
     */
    listTenantsForJobs(): Promise<{ tenantId: string; lakeReady: boolean }[]>;
    /** Resolves an integration's external id (e.g. a GitHub installation) to its tenant. */
    resolveConnection(
      provider: "github",
      externalId: string,
    ): Promise<{ tenantId: string; connectionId: string; status: string } | null>;
  };
  /** Readiness check. Also reports any tenant context on a pooled connection, which must always be null. */
  health(): Promise<{ ok: true; leakedTenantContext: string | null }>;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  /** Connection string for the mm_app runtime role. */
  connectionString: string;
  max?: number;
  ssl?: pg.PoolConfig["ssl"];
}

export function createDb(options: CreateDbOptions): MasterMindDb {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    ssl: options.ssl,
  });
  const db = drizzle(pool, { schema });

  async function setTenant(tx: TenantTx, tenantId: string) {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
  }

  return {
    async withTenant(tenantId, fn) {
      assertTenantId(tenantId);
      return db.transaction(async (tx) => {
        await setTenant(tx, tenantId);
        return fn(tx);
      });
    },

    system: {
      async provisionTenant(input, inTx) {
        return db.transaction(async (tx) => {
          const res = await tx.execute<{ tenant_id: string; admin_member_id: string }>(sql`
            SELECT tenant_id, admin_member_id FROM mm_provision_tenant(
              ${input.name}, ${input.slug}, ${input.workosOrgId},
              ${input.admin.workosUserId}, ${input.admin.email}, ${input.admin.displayName}
            )`);
          const row = res.rows[0];
          if (!row) throw new Error("mm_provision_tenant returned no row");
          const provisioned = { tenantId: row.tenant_id, adminMemberId: row.admin_member_id };
          // The function already set the tenant context for this transaction; set it again
          // so this code doesn't silently depend on that side effect.
          await setTenant(tx, provisioned.tenantId);
          if (inTx) await inTx(tx, provisioned);
          return provisioned;
        });
      },

      async resolveTenantByWorkosOrg(workosOrgId) {
        const res = await db.execute<{ id: string | null }>(
          sql`SELECT mm_resolve_tenant_by_workos_org(${workosOrgId}) AS id`,
        );
        return res.rows[0]?.id ?? null;
      },

      async authenticateAgent(key) {
        if (typeof key !== "string" || !AGENT_KEY_RE.test(key)) return null;
        // Runs outside any transaction, so the tenant context the function sets ends with it.
        const res = await db.execute<{
          tenant_id: string;
          agent_id: string;
          member_id: string;
          scopes: AgentScope[];
          capture_opt_out: boolean;
        }>(sql`SELECT * FROM mm_authenticate_agent(${hashAgentKey(key)})`);
        const row = res.rows[0];
        if (!row) return null;
        return {
          tenantId: row.tenant_id,
          agentId: row.agent_id,
          memberId: row.member_id,
          scopes: row.scopes,
          captureOptOut: row.capture_opt_out,
        };
      },

      async listTenantsForJobs() {
        const res = await db.execute<{ tenant_id: string; lake_ready: boolean }>(
          sql`SELECT tenant_id, lake_ready FROM mm_list_tenants_for_jobs()`,
        );
        return res.rows.map((r) => ({ tenantId: r.tenant_id, lakeReady: r.lake_ready }));
      },

      async resolveConnection(provider, externalId) {
        const res = await db.execute<{ tenant_id: string; connection_id: string; status: string }>(
          sql`SELECT * FROM mm_resolve_connection(${provider}, ${externalId})`,
        );
        const r = res.rows[0];
        return r
          ? { tenantId: r.tenant_id, connectionId: r.connection_id, status: r.status }
          : null;
      },
    },

    async health() {
      const res = await db.execute<{ tenant: string | null }>(
        sql`SELECT mm_current_tenant()::text AS tenant`,
      );
      return { ok: true, leakedTenantContext: res.rows[0]?.tenant ?? null };
    },

    async close() {
      await pool.end();
    },
  };
}
