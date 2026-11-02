import { DELETION_GRACE_DAYS, tenantDeletionRepo } from "@mm/db";
import { requireMemberContext } from "../../../lib/context";
import { db } from "../../../lib/db";
import { TopBar } from "../../top-bar";
import { CancelDeletionForm, DeleteOrganizationForm } from "./forms";

export const dynamic = "force-dynamic";

export default async function OrganizationPage() {
  const ctx = await requireMemberContext({ allowSuspended: true });
  const deletion = await db().withTenant(ctx.tenantId, (tx) => tenantDeletionRepo.getDeletion(tx));
  const scheduled = deletion && ["scheduled", "purging"].includes(deletion.status);
  const isAdmin = ctx.member.role === "admin";
  const when = deletion?.purgeAfter.toISOString().slice(0, 10);

  return (
    <>
      <TopBar tenantName={ctx.tenant.name} email={ctx.user.email} />
      <main>
        <h1>Organization</h1>
        {scheduled ? (
          <div className="card">
            <h2>This organization is being deleted</h2>
            <p>
              Deletion was scheduled on {deletion!.requestedAt.toISOString().slice(0, 10)}. Agents,
              connectors and background work are stopped. On or after <strong>{when}</strong>,
              everything is erased: members, captured work, outcomes, skills, the audit log, raw
              payloads and the lake (whose encryption key is destroyed). This can&apos;t be undone
              once it starts.
            </p>
            {deletion!.status === "scheduled" && isAdmin ? (
              <CancelDeletionForm />
            ) : (
              <p className="muted">
                {deletion!.status === "purging"
                  ? "The deletion has started."
                  : "Ask an admin if this should be cancelled."}
              </p>
            )}
          </div>
        ) : (
          <div className="card">
            <h2>{ctx.tenant.name}</h2>
            <p className="muted">Created {ctx.tenant.createdAt.toISOString().slice(0, 10)}.</p>
            {isAdmin && (
              <>
                <h3>Delete the organization</h3>
                <p>
                  Everything Master Mind holds for {ctx.tenant.name} is erased after a{" "}
                  {DELETION_GRACE_DAYS}-day grace period, during which any admin can cancel. The
                  workspace stops at once: agent keys, connectors and alerts. Master Mind also
                  revokes its HubSpot and Slack access and removes the sign-in organization.
                  Uninstall the GitHub App from your GitHub organization yourself.
                </p>
                <DeleteOrganizationForm name={ctx.tenant.name} />
              </>
            )}
          </div>
        )}
      </main>
    </>
  );
}
