"use server";

// Deleting the organization: an admin schedules it (the workspace is suspended at once) and
// any admin can cancel during the grace period. The purge itself is done by Master Mind's
// operators once the grace period ends; see docs/runbook.md.
import { appendAuditEvent } from "@mm/audit";
import { DELETION_GRACE_DAYS, tenantDeletionRepo } from "@mm/db";
import { revalidatePath } from "next/cache";
import { requireMemberContext } from "../../../lib/context";
import { db } from "../../../lib/db";

type State = { error?: string; ok?: string } | undefined;

export async function scheduleDeletion(_prev: State, formData: FormData): Promise<State> {
  const ctx = await requireMemberContext({ allowSuspended: true });
  if (ctx.member.role !== "admin") return { error: "Only admins can delete the organization." };
  if (String(formData.get("confirm") ?? "").trim() !== ctx.tenant.name) {
    return { error: `Type the organization's name, ${ctx.tenant.name}, to confirm.` };
  }
  const purgeAfter = new Date(Date.now() + DELETION_GRACE_DAYS * 86_400_000);
  await db().withTenant(ctx.tenantId, async (tx) => {
    await tenantDeletionRepo.scheduleDeletion(tx, {
      requestedByMemberId: ctx.member.id,
      purgeAfter,
    });
    await appendAuditEvent(tx, ctx.tenantId, {
      actorType: "member",
      actorId: ctx.member.id,
      action: "tenant.deletion_scheduled",
      targetType: "tenant",
      targetId: ctx.tenantId,
      payload: { purge_after: purgeAfter.toISOString() },
    });
  });
  revalidatePath("/settings/organization");
  return { ok: "Deletion scheduled." };
}

export async function cancelDeletion(_prev: State, _formData: FormData): Promise<State> {
  const ctx = await requireMemberContext({ allowSuspended: true });
  if (ctx.member.role !== "admin") return { error: "Only admins can cancel the deletion." };
  const cancelled = await db().withTenant(ctx.tenantId, async (tx) => {
    const ok = await tenantDeletionRepo.cancelDeletion(tx);
    if (ok) {
      await appendAuditEvent(tx, ctx.tenantId, {
        actorType: "member",
        actorId: ctx.member.id,
        action: "tenant.deletion_cancelled",
        targetType: "tenant",
        targetId: ctx.tenantId,
      });
    }
    return ok;
  });
  revalidatePath("/settings/organization");
  return cancelled
    ? { ok: "Deletion cancelled. Everything works again." }
    : { error: "There is nothing to cancel, or the deletion has already started." };
}
