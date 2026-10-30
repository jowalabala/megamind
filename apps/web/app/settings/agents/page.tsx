import { agentIdentities, asc, members, eq } from "@mm/db";
import { requireMemberContext } from "../../../lib/context";
import { db } from "../../../lib/db";
import { TopBar } from "../../top-bar";
import { revokeAgent } from "./actions";
import { CreateAgentForm } from "./create-form";

export const dynamic = "force-dynamic";

const when = (d: Date | null) =>
  d ? d.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—";

export default async function AgentsPage() {
  const ctx = await requireMemberContext();
  const isAdmin = ctx.member.role === "admin";
  const rows = await db().withTenant(ctx.tenantId, (tx) =>
    tx
      .select({ agent: agentIdentities, ownerEmail: members.email })
      .from(agentIdentities)
      .innerJoin(members, eq(members.id, agentIdentities.memberId))
      .where(isAdmin ? undefined : eq(agentIdentities.memberId, ctx.member.id))
      .orderBy(asc(agentIdentities.createdAt)),
  );
  const apiUrl = process.env.MM_API_URL ?? "http://localhost:4000";

  return (
    <>
      <TopBar tenantName={ctx.tenant.name} email={ctx.user.email} />
      <main>
        <h1>Agents</h1>
        <p className="muted">
          Each AI agent gets its own key. Work it logs is credited to you, and secrets and personal
          data are removed before anything is stored.
          {ctx.member.captureOptOut && (
            <strong> You have opted out of capture, so nothing your agents send is stored.</strong>
          )}
        </p>
        <h2>Connect an agent</h2>
        <div className="card">
          <CreateAgentForm apiUrl={apiUrl} />
        </div>
        <h2>{isAdmin ? `All agents in ${ctx.tenant.name}` : "Your agents"}</h2>
        <div className="card">
          {rows.length === 0 ? (
            <p className="muted">No agents yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  {isAdmin && <th>Owner</th>}
                  <th>Key</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ agent, ownerEmail }) => (
                  <tr key={agent.id}>
                    <td>
                      {agent.name} <span className="pill">{agent.kind}</span>
                    </td>
                    {isAdmin && <td className="muted">{ownerEmail}</td>}
                    <td>
                      <code>{agent.keyPrefix}…</code>
                    </td>
                    <td className="muted">{when(agent.lastUsedAt)}</td>
                    <td>
                      {agent.revokedAt ? (
                        <span className="muted">Revoked</span>
                      ) : (
                        <form action={revokeAgent}>
                          <input type="hidden" name="agentId" value={agent.id} />
                          <button className="danger" type="submit">
                            Revoke
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </>
  );
}
