"use server";

import { appendAuditEvent } from "@mm/audit";
import { getWorkOS } from "@workos-inc/authkit-nextjs";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireMemberContext } from "../../../lib/context";
import { db } from "../../../lib/db";

const Email = z.email().max(254);

export async function inviteMember(
  _prev: { error?: string; ok?: string } | undefined,
  formData: FormData,
) {
  const ctx = await requireMemberContext();
  if (ctx.member.role !== "admin") return { error: "Only admins can invite members." };
  const parsed = Email.safeParse(
    String(formData.get("email") ?? "")
      .trim()
      .toLowerCase(),
  );
  if (!parsed.success) return { error: "Enter a valid email address." };

  const invitation = await getWorkOS().userManagement.sendInvitation({
    email: parsed.data,
    organizationId: ctx.organizationId,
    inviterUserId: ctx.user.id,
  });
  await db().withTenant(ctx.tenantId, (tx) =>
    appendAuditEvent(tx, ctx.tenantId, {
      actorType: "member",
      actorId: ctx.member.id,
      action: "member.invited",
      targetType: "invitation",
      targetId: invitation.id,
      // Audit records are kept for the tenant's lifetime, so store the domain, not the address.
      payload: { emailDomain: parsed.data.split("@")[1] },
    }),
  );
  revalidatePath("/settings/members");
  return { ok: `Invitation sent to ${parsed.data}.` };
}
