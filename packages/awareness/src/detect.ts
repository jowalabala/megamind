// Overlap detection: after a session reports what it touched (actions, an intent), compare it
// with every other live session in the tenant. Run inside that tenant's transaction.
//
// What a session touches = resources of its active intents + resources of its actions in the
// last two hours. Live = active and heard from in the last 15 minutes. Private sessions and
// opted-out members never take part; neither do two sessions of the same person.
import { idFromKey, sessionOverlaps, sql, type OverlapKind, type TenantTx } from "@mm/db";
import { groupResources, rangesIntersect, similarity } from "./resources.ts";

export const ALERT_CHANNEL = "mm_alerts";
export const LIVE_WINDOW_MIN = 15;
export const ACTIONS_WINDOW_MIN = 120;
export const RELATED_THRESHOLD = 0.4;

const SEVERITY: Record<OverlapKind, "high" | "medium" | "low"> = {
  same_lines: "high",
  same_resource: "medium",
  related_work: "low",
};

type LiveSession = {
  id: string;
  member_id: string;
  repo: string | null;
  resources: string[];
  intents: string[];
};

async function liveSessionsWithResources(tx: TenantTx): Promise<LiveSession[]> {
  const res = await tx.execute<LiveSession>(sql`
    SELECT s.id, s.member_id, s.context_redacted ->> 'repo' AS repo,
           coalesce((SELECT array_agg(DISTINCT r) FROM (
              SELECT unnest(i.resources) AS r FROM intents i
               WHERE i.session_id = s.id AND i.status = 'active'
              UNION ALL
              SELECT unnest(e.resources) FROM action_events e
               WHERE e.session_id = s.id
                 AND e.occurred_at > now() - make_interval(mins => ${ACTIONS_WINDOW_MIN})
           ) x), '{}') AS resources,
           coalesce((SELECT array_agg(i.description_redacted ORDER BY i.created_at) FROM intents i
                      WHERE i.session_id = s.id AND i.status = 'active'), '{}') AS intents
      FROM agent_sessions s
      JOIN members m ON m.tenant_id = s.tenant_id AND m.id = s.member_id
     WHERE s.status = 'active' AND NOT s.private AND NOT m.capture_opt_out
       AND s.last_heartbeat_at > now() - make_interval(mins => ${LIVE_WINDOW_MIN})`);
  return res.rows;
}

export interface FoundOverlap {
  id: string;
  sessionA: string;
  sessionB: string;
  kind: OverlapKind;
  resource: string;
  detail: Record<string, unknown>;
  isNew: boolean;
}

export function compareSessions(
  a: LiveSession,
  b: LiveSession,
): Omit<FoundOverlap, "id" | "isNew">[] {
  const [first, second] = a.id < b.id ? [a, b] : [b, a];
  const ra = groupResources(first.resources);
  const rb = groupResources(second.resources);
  const out: Omit<FoundOverlap, "id" | "isNew">[] = [];
  for (const [base, x] of ra) {
    const y = rb.get(base);
    if (!y) continue;
    const hits = rangesIntersect(x.lines, y.lines);
    if (hits.length) {
      out.push({
        sessionA: first.id,
        sessionB: second.id,
        kind: "same_lines",
        resource: base,
        detail: { a_lines: x.lines, b_lines: y.lines, shared: hits },
      });
      continue; // one alert per file: the stronger one
    }
    out.push({
      sessionA: first.id,
      sessionB: second.id,
      kind: "same_resource",
      resource: base,
      detail: { a_lines: x.lines, b_lines: y.lines },
    });
  }
  // Similar intents in the same repository, without touching the same files (yet).
  if (out.length === 0 && first.repo && first.repo === second.repo) {
    let best = 0;
    for (const i of first.intents)
      for (const j of second.intents) best = Math.max(best, similarity(i, j));
    if (best >= RELATED_THRESHOLD) {
      out.push({
        sessionA: first.id,
        sessionB: second.id,
        kind: "related_work",
        resource: `repo:${first.repo}`,
        detail: { similarity: Math.round(best * 100) / 100 },
      });
    }
  }
  return out;
}

/** Compares one session with every other live session; stores what overlaps. */
export async function detectOverlaps(
  tx: TenantTx,
  tenantId: string,
  sessionId: string,
): Promise<FoundOverlap[]> {
  const live = await liveSessionsWithResources(tx);
  const me = live.find((s) => s.id === sessionId);
  if (!me) return []; // private, opted out, ended, or quiet
  const found: FoundOverlap[] = [];
  for (const other of live) {
    if (other.id === me.id || other.member_id === me.member_id) continue;
    for (const o of compareSessions(me, other)) {
      const id = idFromKey([tenantId, "overlap", o.sessionA, o.sessionB, o.kind, o.resource]);
      const rows = await tx
        .insert(sessionOverlaps)
        .values({
          id,
          tenantId,
          sessionA: o.sessionA,
          sessionB: o.sessionB,
          kind: o.kind,
          severity: SEVERITY[o.kind],
          resource: o.resource,
          detail: o.detail,
        })
        .onConflictDoUpdate({
          target: [
            sessionOverlaps.tenantId,
            sessionOverlaps.sessionA,
            sessionOverlaps.sessionB,
            sessionOverlaps.kind,
            sessionOverlaps.resource,
          ],
          set: { lastSeenAt: new Date(), detail: o.detail },
        })
        // xmax = 0 only for a freshly inserted row.
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      found.push({ ...o, id, isNew: Boolean(rows[0]?.inserted) });
    }
  }
  if (found.some((f) => f.isNew)) {
    await tx.execute(sql`SELECT pg_notify(${ALERT_CHANNEL}, ${tenantId})`);
  }
  return found;
}

export interface Alert {
  id: string;
  kind: OverlapKind;
  severity: "high" | "medium" | "low";
  resource: string;
  /** The other side, by the same visibility rules as presence. */
  with: string;
  your_lines: [number, number][];
  their_lines: [number, number][];
  shared_lines: [number, number][];
  similarity: number | null;
  first_seen: string;
}

/** Overlaps involving a session; `undelivered` limits to alerts not yet sent to that side. */
export async function alertsFor(
  tx: TenantTx,
  sessionId: string,
  viewerMemberId: string,
  options: { undelivered?: boolean } = {},
): Promise<Alert[]> {
  const res = await tx.execute<{
    id: string;
    kind: OverlapKind;
    severity: "high" | "medium" | "low";
    resource: string;
    detail: Record<string, unknown>;
    first_seen_at: Date;
    mine_is_a: boolean;
    display_name: string | null;
    visibility_pref: string;
    shares_team: boolean;
    team_name: string | null;
  }>(sql`
    SELECT o.id, o.kind, o.severity, o.resource, o.detail, o.first_seen_at,
           (o.session_a = ${sessionId}) AS mine_is_a,
           m.display_name, m.visibility_pref,
           (EXISTS (SELECT 1 FROM team_members a JOIN team_members b ON a.team_id = b.team_id
                     WHERE a.member_id = m.id AND b.member_id = ${viewerMemberId})
            OR (NOT EXISTS (SELECT 1 FROM team_members a WHERE a.member_id = m.id)
                AND NOT EXISTS (SELECT 1 FROM team_members b WHERE b.member_id = ${viewerMemberId})))
             AS shares_team,
           (SELECT t.name FROM team_members tm JOIN teams t ON t.id = tm.team_id
             WHERE tm.member_id = m.id ORDER BY t.name LIMIT 1) AS team_name
      FROM session_overlaps o
      JOIN agent_sessions other ON other.tenant_id = o.tenant_id
       AND other.id = CASE WHEN o.session_a = ${sessionId} THEN o.session_b ELSE o.session_a END
      JOIN members m ON m.tenant_id = other.tenant_id AND m.id = other.member_id
     WHERE (o.session_a = ${sessionId} OR o.session_b = ${sessionId})
       -- Still hidden if the other side went private or opted out since.
       AND NOT other.private AND NOT m.capture_opt_out
       ${
         options.undelivered
           ? sql`AND CASE WHEN o.session_a = ${sessionId} THEN o.notified_a_at ELSE o.notified_b_at END IS NULL`
           : sql``
       }
     ORDER BY CASE o.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, o.first_seen_at`);
  return res.rows.map((r) => {
    const mine = (r.mine_is_a ? r.detail.a_lines : r.detail.b_lines) as
      [number, number][] | undefined;
    const theirs = (r.mine_is_a ? r.detail.b_lines : r.detail.a_lines) as
      [number, number][] | undefined;
    const who =
      r.visibility_pref === "name" && r.shares_team && r.display_name
        ? r.display_name
        : r.visibility_pref !== "anonymous" && r.team_name
          ? `someone on ${r.team_name}`
          : "a teammate";
    return {
      id: r.id,
      kind: r.kind,
      severity: r.severity,
      resource: r.resource,
      with: who,
      your_lines: mine ?? [],
      their_lines: theirs ?? [],
      shared_lines: (r.detail.shared as [number, number][] | undefined) ?? [],
      similarity: (r.detail.similarity as number | undefined) ?? null,
      first_seen: new Date(r.first_seen_at).toISOString(),
    };
  });
}

export async function markDelivered(tx: TenantTx, sessionId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const list = sql.join(
    ids.map((i) => sql`${i}::uuid`),
    sql`, `,
  );
  await tx.execute(sql`
    UPDATE session_overlaps SET
      notified_a_at = CASE WHEN session_a = ${sessionId} THEN coalesce(notified_a_at, now()) ELSE notified_a_at END,
      notified_b_at = CASE WHEN session_b = ${sessionId} THEN coalesce(notified_b_at, now()) ELSE notified_b_at END
     WHERE id IN (${list})`);
}

export function describeAlert(a: Alert): string {
  const lines = (r: [number, number][]) =>
    r.map(([x, y]) => (x === y ? `${x}` : `${x}-${y}`)).join(", ");
  if (a.kind === "same_lines") {
    return `Conflict likely: ${a.with} is changing the same lines of ${a.resource} (lines ${lines(a.shared_lines)}).`;
  }
  if (a.kind === "same_resource") return `Heads-up: ${a.with} is also working in ${a.resource}.`;
  return `Possibly related: ${a.with} is working on something similar in ${a.resource.replace(/^repo:/, "")}.`;
}
