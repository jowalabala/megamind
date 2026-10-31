// The notification outbox. Rows are written in the same transaction as the event they report
// and sent by the worker (Slack today). Payloads hold ids and already-redacted text only.
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { TenantTx } from "../client.ts";
import {
  categoryOwners,
  members,
  notifications,
  skillSubscriptions,
  type NotificationKind,
} from "../schema.ts";

export type Notification = typeof notifications.$inferSelect;

export async function enqueueNotification(
  tx: TenantTx,
  tenantId: string,
  input: { memberId: string; kind: NotificationKind; payload: Record<string, unknown> },
): Promise<void> {
  await tx.insert(notifications).values({ tenantId, ...input });
}

export async function enqueueMany(
  tx: TenantTx,
  tenantId: string,
  memberIds: string[],
  kind: NotificationKind,
  payload: Record<string, unknown>,
): Promise<number> {
  const ids = [...new Set(memberIds)];
  if (ids.length === 0) return 0;
  await tx
    .insert(notifications)
    .values(ids.map((memberId) => ({ tenantId, memberId, kind, payload })));
  return ids.length;
}

/** Who reviews skills in a category: admins and the category's owners. */
export async function reviewersOf(tx: TenantTx, pack: string, category: string): Promise<string[]> {
  const admins = await tx.select({ id: members.id }).from(members).where(eq(members.role, "admin"));
  const owners = await tx
    .select({ id: categoryOwners.memberId })
    .from(categoryOwners)
    .where(and(eq(categoryOwners.pack, pack), eq(categoryOwners.category, category)));
  return [...new Set([...admins, ...owners].map((m) => m.id))];
}

/** Members subscribed to a category (or to its whole pack). */
export async function subscribersOf(
  tx: TenantTx,
  pack: string,
  category: string,
): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ id: skillSubscriptions.memberId })
    .from(skillSubscriptions)
    .where(
      and(
        eq(skillSubscriptions.pack, pack),
        or(eq(skillSubscriptions.category, category), eq(skillSubscriptions.category, "*")),
      ),
    );
  return rows.map((r) => r.id);
}

/** The oldest pending notifications, locked so two workers never send the same one. */
export async function claimPending(tx: TenantTx, limit = 50): Promise<Notification[]> {
  return tx
    .select()
    .from(notifications)
    .where(eq(notifications.status, "pending"))
    .orderBy(notifications.createdAt)
    .limit(limit)
    .for("update", { skipLocked: true });
}

export async function markNotifications(
  tx: TenantTx,
  ids: string[],
  patch: { status: Notification["status"]; error?: string | null },
): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(notifications)
    .set({
      status: patch.status,
      lastError: patch.error?.slice(0, 1000) ?? null,
      attempts: sql`${notifications.attempts} + 1`,
      ...(patch.status === "sent" ? { sentAt: new Date() } : {}),
    })
    .where(inArray(notifications.id, ids));
}
