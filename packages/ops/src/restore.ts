// Restore drill checks: run against a database restored from backup, they show the backup is
// usable, not just present. The result is kept as evidence (SOC 2: tested restores).
import { verifyAuditChain } from "@mm/audit";
import { createDb, sql } from "@mm/db";
import { readDatabaseState } from "@mm/db/admin";

export interface RestoreCheck {
  checkedAt: string;
  latestMigration: string | null;
  migrations: number;
  tenants: number;
  /** Tenants whose audit chain recomputes to the stored head. */
  auditChainsOk: number;
  auditChainsBroken: { tenantId: string; atSeq: number; reason: string }[];
  rows: Record<string, number>;
  /** Newest captured task: how much data the restore point includes. */
  newestTaskAt: string | null;
  ok: boolean;
}

/** `ownerUrl` connects to the restored database as its owner. */
export async function checkRestoredDatabase(ownerUrl: string): Promise<RestoreCheck> {
  const rows: Record<string, number> = {};
  let newestTaskAt: string | null = null;
  const state = await readDatabaseState(ownerUrl);
  const tenantIds = state.tenantIds;
  const migrations = state.migrations.length;
  const latestMigration = state.migrations.at(-1) ?? null;

  // Row counts and the audit chain, tenant by tenant (forced RLS applies to the owner too).
  const db = createDb({ connectionString: ownerUrl, max: 1 });
  const broken: RestoreCheck["auditChainsBroken"] = [];
  let ok = 0;
  try {
    for (const tenantId of tenantIds) {
      await db.withTenant(tenantId, async (tx) => {
        const v = await verifyAuditChain(tx, tenantId);
        if (v.ok) ok++;
        else broken.push({ tenantId, atSeq: v.brokenAtSeq, reason: v.reason });
        for (const table of ["members", "tasks", "judgments", "skills", "audit_events"]) {
          // Fixed table names only, never input.
          const r = await tx.execute<{ n: number }>(
            sql.raw(`SELECT count(*)::int AS n FROM ${table}`),
          );
          rows[table] = (rows[table] ?? 0) + Number(r.rows[0]!.n);
        }
        const t = await tx.execute<{ at: Date | null }>(
          sql`SELECT max(created_at) AS at FROM tasks`,
        );
        const at = t.rows[0]?.at;
        if (at && (!newestTaskAt || new Date(at).toISOString() > newestTaskAt)) {
          newestTaskAt = new Date(at).toISOString();
        }
      });
    }
  } finally {
    await db.close();
  }
  return {
    checkedAt: new Date().toISOString(),
    latestMigration,
    migrations,
    tenants: tenantIds.length,
    auditChainsOk: ok,
    auditChainsBroken: broken,
    rows,
    newestTaskAt,
    ok: broken.length === 0 && migrations > 0,
  };
}

export function renderRestoreReport(
  c: RestoreCheck,
  timing: { restoreStarted: string; available: string; restoredTo: string; instance: string },
): string {
  const minutes =
    (new Date(timing.available).getTime() - new Date(timing.restoreStarted).getTime()) / 60_000;
  return [
    `# Restore drill ${c.checkedAt.slice(0, 10)}`,
    "",
    `Result: **${c.ok ? "passed" : "FAILED"}**`,
    "",
    `- Restored instance: \`${timing.instance}\` (deleted after the checks)`,
    `- Restore point: ${timing.restoredTo}`,
    `- Time to restore: ${minutes.toFixed(1)} minutes`,
    `- Migrations present: ${c.migrations} (latest \`${c.latestMigration ?? "none"}\`)`,
    `- Tenants: ${c.tenants}; audit chains intact: ${c.auditChainsOk}/${c.tenants}`,
    `- Newest captured task: ${c.newestTaskAt ?? "none"}`,
    `- Rows: ${Object.entries(c.rows)
      .map(([t, n]) => `${t} ${n}`)
      .join(", ")}`,
    ...(c.auditChainsBroken.length
      ? [
          "",
          "Broken audit chains:",
          ...c.auditChainsBroken.map((b) => `- ${b.tenantId} at #${b.atSeq}: ${b.reason}`),
        ]
      : []),
    "",
  ].join("\n");
}
