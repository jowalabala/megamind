// Tenant versions of packs. Each save is a new version; the latest one is in force.
import { desc, eq, sql } from "drizzle-orm";
import type { TenantTx } from "../client.ts";
import { tenantPacks } from "../schema.ts";

export type TenantPack = typeof tenantPacks.$inferSelect;

/** Latest version of each pack this tenant has edited. */
export async function latestTenantPacks(tx: TenantTx): Promise<TenantPack[]> {
  const res = await tx.execute<{
    tenant_id: string;
    pack_id: string;
    version: number;
    yaml: string;
    created_by_member_id: string | null;
    created_at: Date;
  }>(sql`
    SELECT DISTINCT ON (pack_id) tenant_id, pack_id, version, yaml, created_by_member_id, created_at
      FROM tenant_packs ORDER BY pack_id, version DESC`);
  return res.rows.map((r) => ({
    tenantId: r.tenant_id,
    packId: r.pack_id,
    version: Number(r.version),
    yaml: r.yaml,
    createdByMemberId: r.created_by_member_id,
    createdAt: new Date(r.created_at),
  }));
}

/** Every stored version of one pack (newest first). Old versions still judge old tasks. */
export async function packVersions(tx: TenantTx, packId: string): Promise<TenantPack[]> {
  return tx
    .select()
    .from(tenantPacks)
    .where(eq(tenantPacks.packId, packId))
    .orderBy(desc(tenantPacks.version));
}

export class PackVersionConflictError extends Error {
  override name = "PackVersionConflictError";
}

/**
 * Stores a new version. `expectedVersion` is the version the editor started from (0 for the
 * first edit); if someone saved in between, this throws instead of overwriting their change.
 */
export async function savePackVersion(
  tx: TenantTx,
  tenantId: string,
  input: { packId: string; yaml: string; expectedVersion: number; memberId: string },
): Promise<TenantPack> {
  // Versions are append-only (no row to lock), so concurrent saves queue on an advisory lock.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:pack:${input.packId}`}))`,
  );
  const [latest] = await tx
    .select({ version: tenantPacks.version })
    .from(tenantPacks)
    .where(eq(tenantPacks.packId, input.packId))
    .orderBy(desc(tenantPacks.version))
    .limit(1);
  const current = latest?.version ?? 0;
  if (current !== input.expectedVersion) {
    throw new PackVersionConflictError(
      `Someone saved version ${current} of this pack while you were editing. Reload and try again.`,
    );
  }
  const [row] = await tx
    .insert(tenantPacks)
    .values({
      tenantId,
      packId: input.packId,
      version: current + 1,
      yaml: input.yaml,
      createdByMemberId: input.memberId,
    })
    .returning();
  return row!;
}
