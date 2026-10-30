import { memberRepo } from "@mm/db";
import { requireMemberContext } from "../../../lib/context";
import { db } from "../../../lib/db";
import { TopBar } from "../../top-bar";
import { EraseMemberForm } from "./erase-form";
import { InviteForm } from "./invite-form";

export const dynamic = "force-dynamic";

export default async function MembersPage() {
  const ctx = await requireMemberContext();
  const list = await db().withTenant(ctx.tenantId, (tx) => memberRepo.listMembers(tx));
  const isAdmin = ctx.member.role === "admin";

  return (
    <>
      <TopBar tenantName={ctx.tenant.name} email={ctx.user.email} />
      <main>
        <h1>Members</h1>
        {isAdmin && (
          <>
            <h2>Invite a teammate</h2>
            <div className="card">
              <InviteForm />
            </div>
          </>
        )}
        <h2>Everyone in {ctx.tenant.name}</h2>
        {isAdmin && (
          <p className="muted">
            Removing a member signs them out of {ctx.tenant.name} and erases everything their agents
            captured: database rows at once, raw copies and the data lake within minutes. Old lake
            snapshots expire within 11 days.
          </p>
        )}
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Capture</th>
                {isAdmin && <th />}
              </tr>
            </thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.id}>
                  <td>{m.displayName ?? "—"}</td>
                  <td className="muted">{m.email}</td>
                  <td>
                    <span className="pill">{m.role}</span>
                  </td>
                  <td className="muted">{m.captureOptOut ? "Opted out" : "On"}</td>
                  {isAdmin && (
                    <td>
                      {m.id !== ctx.member.id && (
                        <EraseMemberForm memberId={m.id} label={m.displayName ?? m.email} />
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}
