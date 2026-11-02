// Tenant deletion, the app side: an admin schedules it (the tenant is suspended at once) and
// can cancel during the grace period. The purge itself is an operator step (@mm/ops).
import { eq, sql } from "drizzle-orm";
import type { TenantTx } from "../client.ts";
import { tenantDeletions, tenants } from "../schema.ts";

export type TenantDeletion = typeof tenantDeletions.$inferSelect;

/** Grace period before an operator may purge. Admins can cancel until then. */
export const DELETION_GRACE_DAYS = 7;

export async function scheduleDeletion(
  tx: TenantTx,
  input: { requestedByMemberId: string; purgeAfter: Date },
): Promise<TenantDeletion> {
  await tx.execute(
    sql`SELECT mm_schedule_tenant_deletion(${input.requestedByMemberId}, ${input.purgeAfter.toISOString()})`,
  );
  const [row] = await tx.select().from(tenantDeletions);
  return row!;
}

/** False when nothing was scheduled, or the purge already started. */
export async function cancelDeletion(tx: TenantTx): Promise<boolean> {
  const res = await tx.execute<{ ok: boolean }>(sql`SELECT mm_cancel_tenant_deletion() AS ok`);
  return res.rows[0]?.ok === true;
}

export async function getDeletion(tx: TenantTx): Promise<TenantDeletion | null> {
  const [row] = await tx.select().from(tenantDeletions);
  return row ?? null;
}

export async function isSuspended(tx: TenantTx, tenantId: string): Promise<boolean> {
  const [t] = await tx
    .select({ suspendedAt: tenants.suspendedAt })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return !!t?.suspendedAt;
}
