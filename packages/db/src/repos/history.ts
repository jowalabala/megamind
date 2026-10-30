// Hot history search: what was done before, and how it went. Postgres only (90 days of
// actions, all tasks); older actions live in the lake.
//
// Privacy rules, applied in SQL so nothing hidden ever leaves the database:
// - Other members' private sessions are invisible, and so is everything from members who
//   opted out of capture.
// - Who did something is shown according to the author's visibility preference: their name
//   only to people who share a team with them, otherwise their team, otherwise "a teammate".
import { sql } from "drizzle-orm";
import type { TenantTx } from "../client.ts";

export interface HistoryQuery {
  /** The member searching (via their agent). Their own items are always visible. */
  requesterMemberId: string;
  /** Free text, matched against redacted titles and summaries. */
  text?: string;
  /** Substring of a resource or external ref, e.g. "src/billing/" or "github:pr:acme/api#12". */
  resource?: string;
  kinds?: ("tasks" | "actions")[];
  since?: Date;
  before?: Date;
  limit?: number;
}

export interface HistoryOutcome {
  metric: string;
  value: number;
  n: number;
}

export interface HistoryItem {
  type: "task" | "action";
  id: string;
  at: string;
  /** "you", a name, a team name, or "a teammate". */
  who: string;
  title?: string;
  summary: string;
  resources: string[];
  taskId: string | null;
  outcomes?: HistoryOutcome[];
  kind?: string;
}

const MAX_LIMIT = 25;
const SNIPPET = 500;

function likeContains(s: string): string {
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

type AuthorRow = {
  /** Null for connector tasks (e.g. a PR) whose author hasn't linked their account. */
  member_id: string | null;
  display_name: string | null;
  visibility_pref: "name" | "team" | "anonymous" | null;
  shares_team: boolean;
  team_name: string | null;
};

function who(row: AuthorRow, requester: string): string {
  if (row.member_id === null) return "a contributor";
  if (row.member_id === requester) return "you";
  if (row.visibility_pref === "name" && row.shares_team && row.display_name) {
    return row.display_name;
  }
  if (row.visibility_pref !== "anonymous" && row.team_name) return `someone on ${row.team_name}`;
  return "a teammate";
}

// Author columns and the visibility filter, shared by both queries. `x` is the row alias.
const author = (requester: string) => sql`
  m.id AS member_id, m.display_name, m.visibility_pref,
  (
    -- Members with no teams at all are treated as one team.
    EXISTS (
      SELECT 1 FROM team_members a JOIN team_members b ON a.team_id = b.team_id
       WHERE a.member_id = m.id AND b.member_id = ${requester}
    ) OR (
      NOT EXISTS (SELECT 1 FROM team_members a WHERE a.member_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM team_members b WHERE b.member_id = ${requester})
    )
  ) AS shares_team,
  (SELECT t.name FROM team_members tm JOIN teams t ON t.id = tm.team_id
    WHERE tm.member_id = m.id ORDER BY t.name LIMIT 1) AS team_name`;

const visible = (requester: string) => sql`
  (m.id = ${requester}
   OR (NOT coalesce(m.capture_opt_out, false) AND NOT coalesce(s.private, false)))`;

export async function searchHistory(tx: TenantTx, q: HistoryQuery): Promise<HistoryItem[]> {
  const text = q.text?.trim() || null;
  const resource = q.resource?.trim() || null;
  if (!text && !resource) throw new Error("searchHistory needs text or a resource.");
  const limit = Math.min(Math.max(q.limit ?? 10, 1), MAX_LIMIT);
  const kinds = new Set(q.kinds?.length ? q.kinds : ["tasks", "actions"]);
  const me = q.requesterMemberId;
  const tsq = text ? sql`websearch_to_tsquery('simple', ${text})` : sql`NULL::tsquery`;
  const like = resource ? likeContains(resource) : null;
  const timeFilter = (col: ReturnType<typeof sql.raw>) => sql`
    ${q.since ? sql`AND ${col} >= ${q.since.toISOString()}` : sql``}
    ${q.before ? sql`AND ${col} < ${q.before.toISOString()}` : sql``}`;

  const items: (HistoryItem & { rank: number })[] = [];

  if (kinds.has("tasks")) {
    const res = await tx.execute<
      AuthorRow & {
        id: string;
        title: string;
        summary: string;
        created_at: Date;
        refs: string[] | null;
        outcomes: HistoryOutcome[] | null;
        rank: number;
      }
    >(sql`
      SELECT x.id, x.title_redacted AS title, left(x.summary_redacted, ${SNIPPET}) AS summary,
             x.created_at,
             ${text ? sql`ts_rank(x.search, ${tsq})` : sql`0`}::float8 AS rank,
             (SELECT array_agg(r.ref ORDER BY r.ref) FROM external_refs r WHERE r.task_id = x.id) AS refs,
             (SELECT jsonb_agg(jsonb_build_object('metric', o.metric_key, 'value', o.value, 'n', o.n))
                FROM (SELECT DISTINCT ON (metric_key) metric_key, value, n FROM metric_observations
                       WHERE task_id = x.id ORDER BY metric_key, observed_at DESC) o) AS outcomes,
             ${author(me)}
        FROM tasks x
        LEFT JOIN members m ON m.tenant_id = x.tenant_id AND m.id = x.member_id
        LEFT JOIN agent_sessions s ON s.tenant_id = x.tenant_id AND s.id = x.agent_session_id
       WHERE ${visible(me)}
         ${text ? sql`AND x.search @@ ${tsq}` : sql``}
         ${
           like
             ? sql`AND (EXISTS (SELECT 1 FROM external_refs r WHERE r.task_id = x.id AND r.ref LIKE ${like})
                    OR EXISTS (SELECT 1 FROM action_events e, unnest(e.resources) res
                                WHERE e.task_id = x.id AND res LIKE ${like}))`
             : sql``
         }
         ${timeFilter(sql.raw("x.created_at"))}
       ORDER BY rank DESC, x.created_at DESC
       LIMIT ${limit}`);
    for (const r of res.rows) {
      items.push({
        type: "task",
        id: r.id,
        at: new Date(r.created_at).toISOString(),
        who: who(r, me),
        title: r.title,
        summary: r.summary,
        resources: r.refs ?? [],
        taskId: r.id,
        outcomes: r.outcomes ?? [],
        rank: Number(r.rank),
      });
    }
  }

  if (kinds.has("actions")) {
    const res = await tx.execute<
      AuthorRow & {
        id: string;
        kind: string;
        summary: string;
        resources: string[];
        task_id: string | null;
        occurred_at: Date;
        rank: number;
      }
    >(sql`
      SELECT x.id, x.kind, left(x.summary_redacted, ${SNIPPET}) AS summary, x.resources,
             x.task_id, x.occurred_at,
             ${text ? sql`ts_rank(x.search, ${tsq})` : sql`0`}::float8 AS rank,
             ${author(me)}
        FROM action_events x
        JOIN members m ON m.tenant_id = x.tenant_id AND m.id = x.member_id
        JOIN agent_sessions s ON s.tenant_id = x.tenant_id AND s.id = x.session_id
       WHERE ${visible(me)}
         ${text ? sql`AND x.search @@ ${tsq}` : sql``}
         ${like ? sql`AND EXISTS (SELECT 1 FROM unnest(x.resources) res WHERE res LIKE ${like})` : sql``}
         ${timeFilter(sql.raw("x.occurred_at"))}
       ORDER BY rank DESC, x.occurred_at DESC
       LIMIT ${limit}`);
    for (const r of res.rows) {
      items.push({
        type: "action",
        id: r.id,
        kind: r.kind,
        at: new Date(r.occurred_at).toISOString(),
        who: who(r, me),
        summary: r.summary,
        resources: r.resources,
        taskId: r.task_id,
        rank: Number(r.rank),
      });
    }
  }

  // Tasks and actions ranked together: relevance first, then recency.
  items.sort((a, b) => b.rank - a.rank || b.at.localeCompare(a.at));
  return items.slice(0, limit).map(({ rank: _rank, ...item }) => item);
}

/** Deletes hot action events older than the retention window. They remain in the lake. */
export async function pruneHotActions(tx: TenantTx, olderThanDays = 90): Promise<number> {
  const res = await tx.execute(
    sql`DELETE FROM action_events WHERE occurred_at < now() - make_interval(days => ${olderThanDays})`,
  );
  return res.rowCount ?? 0;
}
