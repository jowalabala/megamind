import { appendAuditEvent } from "@mm/audit";
import { members, tenants, eq } from "@mm/db";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import { db } from "./db";

/**
 * The signed-in member and their tenant. The tenant comes only from the WorkOS
 * organization in the verified session, never from the URL or the request body.
 */
export async function requireMemberContext() {
  const { user, organizationId } = await withAuth({ ensureSignedIn: true });
  if (!organizationId) redirect("/onboarding");
  const tenantId = await db().system.resolveTenantByWorkosOrg(organizationId);
  if (!tenantId) redirect("/onboarding");

  return db().withTenant(tenantId, async (tx) => {
    const displayName = [user.firstName, user.lastName].filter(Boolean).join(" ") || null;
    const { member, created } = await members.ensureMember(tx, tenantId, {
      workosUserId: user.id,
      email: user.email,
      displayName,
    });
    if (created) {
      await appendAuditEvent(tx, tenantId, {
        actorType: "member",
        actorId: member.id,
        action: "member.joined",
        targetType: "member",
        targetId: member.id,
      });
    }
    const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, tenantId));
    return { user, organizationId, tenantId, tenant: tenant!, member };
  });
}
