import { members } from "@mm/db";
import { requireMemberContext } from "../../../lib/context";
import { db } from "../../../lib/db";
import { TopBar } from "../../top-bar";
import { InviteForm } from "./invite-form";

export const dynamic = "force-dynamic";

export default async function MembersPage() {
  const ctx = await requireMemberContext();
  const list = await db().withTenant(ctx.tenantId, (tx) => members.listMembers(tx));
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
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Capture</th>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}
