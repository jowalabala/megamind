import { auditEvents, desc, members, teams } from "@mm/db";
import { requireMemberContext } from "../../lib/context";
import { db } from "../../lib/db";
import { TopBar } from "../top-bar";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const ctx = await requireMemberContext();
  const data = await db().withTenant(ctx.tenantId, async (tx) => {
    const memberList = await members.listMembers(tx);
    const teamList = await tx.select().from(teams);
    const recent =
      ctx.member.role === "admin"
        ? await tx.select().from(auditEvents).orderBy(desc(auditEvents.seq)).limit(10)
        : [];
    return { memberCount: memberList.length, teamCount: teamList.length, recent };
  });

  return (
    <>
      <TopBar tenantName={ctx.tenant.name} email={ctx.user.email} />
      <main>
        <h1>Welcome{ctx.user.firstName ? `, ${ctx.user.firstName}` : ""}</h1>
        <p className="muted">
          You&apos;re signed in to <strong>{ctx.tenant.name}</strong> as{" "}
          <span className="pill">{ctx.member.role}</span>
        </p>
        <div className="grid">
          <div className="card stat">
            <strong>{data.memberCount}</strong> members
          </div>
          <div className="card stat">
            <strong>{data.teamCount}</strong> teams
          </div>
          <div className="card stat">
            <strong>0</strong> skills
            <span className="muted"> · arrive once connectors are on</span>
          </div>
        </div>

        {ctx.member.role === "admin" && (
          <>
            <h2>Recent audit events</h2>
            <div className="card">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((e) => (
                    <tr key={e.id}>
                      <td>{e.seq}</td>
                      <td>
                        <code>{e.action}</code>
                      </td>
                      <td className="muted">{e.actorType}</td>
                      <td className="muted">
                        {e.occurredAt.toISOString().replace("T", " ").slice(0, 19)} UTC
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </>
  );
}
