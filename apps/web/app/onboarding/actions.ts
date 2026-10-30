"use server";

import { randomBytes } from "node:crypto";
import { appendAuditEvent } from "@mm/audit";
import { getWorkOS, switchToOrganization, withAuth } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "../../lib/db";

const OrgName = z.string().trim().min(2, "At least 2 characters").max(100);

function slugFor(name: string) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "org";
  return `${base}-${randomBytes(3).toString("hex")}`;
}

export async function createOrganization(
  _prev: { error?: string } | undefined,
  formData: FormData,
) {
  const { user, organizationId } = await withAuth({ ensureSignedIn: true });
  if (organizationId && (await db().system.resolveTenantByWorkosOrg(organizationId))) {
    redirect("/dashboard");
  }
  const parsed = OrgName.safeParse(formData.get("name"));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid name" };
  const name = parsed.data;

  const workos = getWorkOS();
  const org = await workos.organizations.createOrganization({ name });
  try {
    await workos.userManagement.createOrganizationMembership({
      organizationId: org.id,
      userId: user.id,
    });
    await db().system.provisionTenant(
      {
        name,
        slug: slugFor(name),
        workosOrgId: org.id,
        admin: {
          workosUserId: user.id,
          email: user.email,
          displayName: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
        },
      },
      async (tx, t) => {
        await appendAuditEvent(tx, t.tenantId, {
          actorType: "member",
          actorId: t.adminMemberId,
          action: "tenant.created",
          targetType: "tenant",
          targetId: t.tenantId,
          payload: { workosOrgId: org.id },
        });
      },
    );
  } catch (err) {
    // Don't leave an orphaned WorkOS organization behind.
    await workos.organizations.deleteOrganization(org.id).catch(() => {});
    throw err;
  }

  await switchToOrganization(org.id);
  redirect("/dashboard");
}
