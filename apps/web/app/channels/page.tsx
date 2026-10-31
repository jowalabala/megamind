import { getSettings } from "@mm/collab";
import { sql } from "@mm/db";
import { requireMemberContext } from "../../lib/context";
import { db } from "../../lib/db";
import { TopBar } from "../top-bar";
import { closeChannelAction, decideChannel, setCollabEnabled, setCrossTeam } from "./actions";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  status: string;
  purpose: string;
  share: string[];
  ttl: number;
  closes_at: Date | null;
  my_approval: string | null;
  others: string;
  messages: number;
};

export default async function ChannelsPage() {
  const ctx = await requireMemberContext();
  const isAdmin = ctx.member.role === "admin";
  const { rows, settings } = await db().withTenant(ctx.tenantId, async (tx) => ({
    settings: await getSettings(tx, ctx.tenantId),
    rows: (
      await tx.execute<Row>(sql`
        SELECT c.id, c.status, c.purpose_redacted AS purpose,
               ARRAY(SELECT jsonb_array_elements_text(c.scope -> 'share')) AS share,
               (c.scope ->> 'ttl_minutes')::int AS ttl, c.closes_at,
               (SELECT approval FROM channel_participants p WHERE p.channel_id = c.id AND p.member_id = ${ctx.member.id} LIMIT 1) AS my_approval,
               (SELECT string_agg(coalesce(m.display_name, 'a teammate'), ', ') FROM channel_participants p
                  JOIN members m ON m.id = p.member_id WHERE p.channel_id = c.id AND p.member_id <> ${ctx.member.id}) AS others,
               c.last_seq::int AS messages
          FROM channels c
         WHERE c.status IN ('requested', 'open')
           AND (${isAdmin} OR EXISTS (SELECT 1 FROM channel_participants p WHERE p.channel_id = c.id AND p.member_id = ${ctx.member.id}))
         ORDER BY c.created_at DESC`)
    ).rows,
  }));
  const pending = rows.filter((r) => r.status === "requested" && r.my_approval === "pending");
  const open = rows.filter((r) => !(r.status === "requested" && r.my_approval === "pending"));

  return (
    <>
      <TopBar tenantName={ctx.tenant.name} email={ctx.user.email} />
      <main>
        <h1>Channels</h1>
        <p className="muted">
          A channel lets your agent and a teammate&apos;s agent coordinate directly, for a limited
          time and only about what you approve. Agents can ask; only people can say yes.
        </p>
        <h2>Waiting for you</h2>
        <div className="card">
          {pending.length === 0 ? (
            <p className="muted">Nothing to approve.</p>
          ) : (
            pending.map((r) => (
              <div key={r.id} className="notice">
                <p>
                  <strong>With {r.others || "a teammate"}:</strong> {r.purpose}
                </p>
                <p className="muted">
                  May share: {r.share.join(", ")} · up to {r.ttl} minutes
                </p>
                <form action={decideChannel} className="inline">
                  <input type="hidden" name="channelId" value={r.id} />
                  <button type="submit" name="decision" value="approve">
                    Approve
                  </button>
                  <button type="submit" name="decision" value="decline" className="danger">
                    Decline
                  </button>
                </form>
              </div>
            ))
          )}
        </div>
        <h2>{isAdmin ? "All live channels" : "Your channels"}</h2>
        <div className="card">
          {open.length === 0 ? (
            <p className="muted">None.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Purpose</th>
                  <th>With</th>
                  <th>Status</th>
                  <th>Messages</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {open.map((r) => (
                  <tr key={r.id}>
                    <td>{r.purpose}</td>
                    <td className="muted">{r.others || "—"}</td>
                    <td>
                      <span className="pill">{r.status}</span>
                      {r.closes_at && (
                        <span className="muted">
                          {" "}
                          until {new Date(r.closes_at).toISOString().slice(11, 16)} UTC
                        </span>
                      )}
                    </td>
                    <td className="muted">{r.messages}</td>
                    <td>
                      <form action={closeChannelAction}>
                        <input type="hidden" name="channelId" value={r.id} />
                        <button type="submit" className="danger">
                          Close
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {isAdmin && (
          <>
            <h2>Workspace rules</h2>
            <div className="card">
              <form action={setCollabEnabled} className="inline">
                <input type="hidden" name="enabled" value={settings.enabled ? "false" : "true"} />
                <span>
                  Channels are <strong>{settings.enabled ? "on" : "off"}</strong>.
                </span>{" "}
                <button type="submit" className={settings.enabled ? "danger" : ""}>
                  {settings.enabled ? "Turn off and close all" : "Turn on"}
                </button>
              </form>
              <form action={setCrossTeam} className="inline">
                <input
                  type="hidden"
                  name="allowed"
                  value={settings.crossTeamAllowed ? "false" : "true"}
                />
                <span>
                  Channels across teams are{" "}
                  <strong>{settings.crossTeamAllowed ? "allowed" : "not allowed"}</strong>.
                </span>{" "}
                <button type="submit">{settings.crossTeamAllowed ? "Disallow" : "Allow"}</button>
              </form>
              <p className="muted">
                Longest channel: {settings.maxTtlMinutes} minutes. May share:{" "}
                {settings.allowedShare.join(", ")}.
              </p>
            </div>
          </>
        )}
      </main>
    </>
  );
}
