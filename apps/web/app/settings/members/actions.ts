"use server";

import { appendAuditEvent } from "@mm/audit";
import { eq, erasureRepo, ErasureNotAllowedError, members } from "@mm/db";
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

/**
 * Removes a member and erases what they captured. Their WorkOS membership goes first, so
 * they can't sign back in (which would recreate the member). Postgres rows are deleted
 * now; the worker removes their raw payloads and lake rows over the next ~15 minutes.
 */
export async function eraseMember(
  _prev: { error?: string; ok?: string } | undefined,
  formData: FormData,
) {
  const ctx = await requireMemberContext();
  if (ctx.member.role !== "admin") return { error: "Only admins can remove members." };
  const memberId = z.uuid().safeParse(formData.get("memberId"));
  if (!memberId.success) return { error: "Unknown member." };
  if (String(formData.get("confirm") ?? "").trim() !== "ERASE") {
    return { error: "Type ERASE to confirm." };
  }
  if (memberId.data === ctx.member.id) {
    return { error: "You can't remove yourself; ask another admin." };
  }

  const [subject] = await db().withTenant(ctx.tenantId, (tx) =>
    tx
      .select({ workosUserId: members.workosUserId })
      .from(members)
      .where(eq(members.id, memberId.data)),
  );
  if (!subject) return { error: "That member no longer exists." };

  const workos = getWorkOS();
  const memberships = await workos.userManagement.listOrganizationMemberships({
    organizationId: ctx.organizationId,
    userId: subject.workosUserId,
  });
  for (const m of memberships.data) {
    await workos.userManagement.deleteOrganizationMembership(m.id);
  }

  try {
    await db().withTenant(ctx.tenantId, async (tx) => {
      const request = await erasureRepo.requestMemberErasure(tx, ctx.tenantId, {
        subjectMemberId: memberId.data,
        requestedByMemberId: ctx.member.id,
      });
      await appendAuditEvent(tx, ctx.tenantId, {
        actorType: "member",
        actorId: ctx.member.id,
        action: "member.erasure_requested",
        targetType: "erasure_request",
        targetId: request.id,
        payload: { subjectMemberId: memberId.data },
      });
    });
  } catch (err) {
    if (err instanceof ErasureNotAllowedError) return { error: err.message };
    throw err;
  }
  revalidatePath("/settings/members");
  return { ok: "Member removed. Their data is deleted now; raw and lake copies within minutes." };
}
