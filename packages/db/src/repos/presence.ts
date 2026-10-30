// Live presence: which agent sessions are active right now, as a given member may see them.
//
// The same visibility rules as history search, applied in SQL:
// - other members' private sessions, and everything from opted-out members, are invisible;
// - an author's name is shown only to people who share a team with them (and only if their
//   preference allows); otherwise their team; otherwise "a teammate";
// - branch names (which can say what someone is working on) are shown only within a team.
import { and, eq, sql } from "drizzle-orm";
import type { TenantTx } from "../client.ts";
import { agentSessions } from "../schema.ts";

export interface LiveSession {
  session_id: string;
  who: string;
  you: boolean;
  tool: string | null;
  repo: string | null;
  branch: string | null;
  since: string;
  last_seen: string;
}

/** Registers (or resumes) a live session. Private stays private once set. */
export async function upsertLiveSession(
  tx: TenantTx,
  tenantId: string,
  input: {
    agentId: string;
    memberId: string;
    clientSessionId: string;
    context: Record<string, unknown>;
    private: boolean;
  },
): Promise<{ id: string; private: boolean }> {
  const [row] = await tx
    .insert(agentSessions)
    .values({
      tenantId,
      agentIdentityId: input.agentId,
      memberId: input.memberId,
      clientSessionId: input.clientSessionId,
      contextRedacted: input.context,
      private: input.private,
    })
    .onConflictDoUpdate({
      target: [
        agentSessions.tenantId,
        agentSessions.agentIdentityId,
        agentSessions.clientSessionId,
      ],
      set: {
        lastHeartbeatAt: new Date(),
        contextRedacted: input.context,
        status: "active",
        endedAt: null,
        private: sql`${agentSessions.private} OR ${input.private}`,
      },
    })
    .returning({ id: agentSessions.id, private: agentSessions.private });
  return row!;
}

export async function heartbeat(tx: TenantTx, sessionId: string): Promise<void> {
  await tx
    .update(agentSessions)
    .set({ lastHeartbeatAt: new Date() })
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.status, "active")));
}

export async function endSession(tx: TenantTx, sessionId: string): Promise<void> {
  await tx
    .update(agentSessions)
    .set({ status: "ended", endedAt: new Date() })
    .where(eq(agentSessions.id, sessionId));
}

export async function liveSessions(
  tx: TenantTx,
  viewerMemberId: string,
  ttlMs = 60_000,
): Promise<LiveSession[]> {
  const res = await tx.execute<{
    session_id: string;
    member_id: string;
    display_name: string | null;
    visibility_pref: "name" | "team" | "anonymous";
    shares_team: boolean;
    team_name: string | null;
    tool: string | null;
    repo: string | null;
    branch: string | null;
    since: Date;
    last_seen: Date;
  }>(sql`
    SELECT s.id AS session_id, m.id AS member_id, m.display_name, m.visibility_pref,
           (EXISTS (SELECT 1 FROM team_members a JOIN team_members b ON a.team_id = b.team_id
                     WHERE a.member_id = m.id AND b.member_id = ${viewerMemberId})
            OR (NOT EXISTS (SELECT 1 FROM team_members a WHERE a.member_id = m.id)
                AND NOT EXISTS (SELECT 1 FROM team_members b WHERE b.member_id = ${viewerMemberId})))
             AS shares_team,
           (SELECT t.name FROM team_members tm JOIN teams t ON t.id = tm.team_id
             WHERE tm.member_id = m.id ORDER BY t.name LIMIT 1) AS team_name,
           s.context_redacted ->> 'tool' AS tool,
           s.context_redacted ->> 'repo' AS repo,
           s.context_redacted ->> 'branch' AS branch,
           s.started_at AS since, s.last_heartbeat_at AS last_seen
      FROM agent_sessions s
      JOIN members m ON m.tenant_id = s.tenant_id AND m.id = s.member_id
     WHERE s.status = 'active'
       AND s.last_heartbeat_at > now() - make_interval(secs => ${ttlMs / 1000})
       AND (m.id = ${viewerMemberId} OR (NOT m.capture_opt_out AND NOT s.private))
     ORDER BY s.started_at, s.id
     LIMIT 200`);
  return res.rows.map((r) => {
    const you = r.member_id === viewerMemberId;
    const who = you
      ? "you"
      : r.visibility_pref === "name" && r.shares_team && r.display_name
        ? r.display_name
        : r.visibility_pref !== "anonymous" && r.team_name
          ? `someone on ${r.team_name}`
          : "a teammate";
    return {
      session_id: r.session_id,
      who,
      you,
      tool: r.tool,
      repo: r.repo,
      branch: you || r.shares_team ? r.branch : null,
      since: new Date(r.since).toISOString(),
      last_seen: new Date(r.last_seen).toISOString(),
    };
  });
}
