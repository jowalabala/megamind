// Attribution: which connector task (a PR, a HubSpot sequence) an agent's task produced, so
// the agent's account of how it did the work meets the outcome measured on the result.
//
// 1. By reference (confidence 1.0): the agent named it in external_refs, e.g.
//    hubspot:sequence:123 or github:pr:acme/api#45, and a connector task has the same ref.
// 2. By heuristic: same person, the result was created around when the agent finished
//    (24 hours before to 72 hours after), and similar titles. Confidence comes from how close
//    the time and titles are. Below ATTRIBUTION_MIN_CONFIDENCE it's kept for review but not
//    used for learning or measurement.
import { ATTRIBUTION_MIN_CONFIDENCE, sql, taskAttributions, type MasterMindDb } from "@mm/db";

export const HEURISTIC = {
  beforeHours: 24,
  afterHours: 72,
  /** Weaker matches aren't stored at all. */
  storeFrom: 0.5,
};

export { ATTRIBUTION_MIN_CONFIDENCE };

const STOP = new Set(
  "a an and the of for to in on with by from at is are be this that it as or our your new add update fix".split(
    " ",
  ),
);

export function titleWords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / (a.size + b.size - both);
}

/** Pure: how confident a heuristic match is, from the time gap and the title overlap. */
export function heuristicConfidence(hoursFromAgentToResult: number, similarity: number): number {
  const h = hoursFromAgentToResult;
  if (h < -HEURISTIC.beforeHours || h > HEURISTIC.afterHours) return 0;
  const window = h < 0 ? HEURISTIC.beforeHours : HEURISTIC.afterHours;
  const time = 1 - Math.abs(h) / window;
  return Math.round((0.4 + 0.25 * time + 0.35 * similarity) * 1000) / 1000;
}

const CONNECTOR_SOURCES = sql`('github', 'hubspot')`;
const AGENT_SOURCES = sql`('mcp', 'bridge')`;

/** Attributes recent agent tasks. Returns how many attributions were added or upgraded. */
export async function attributeTasks(
  deps: { db: MasterMindDb; now?: () => Date },
  tenantId: string,
  options: { days?: number } = {},
): Promise<{ reference: number; heuristic: number }> {
  const now = deps.now?.() ?? new Date();
  const since = new Date(now.getTime() - (options.days ?? 30) * 86_400_000).toISOString();
  return deps.db.withTenant(tenantId, async (tx) => {
    const byRef = await tx.execute(sql`
      INSERT INTO task_attributions (tenant_id, task_id, target_task_id, method, confidence, evidence)
      SELECT DISTINCT ON (a.task_id, c.task_id) ${tenantId}::uuid, a.task_id, c.task_id, 'reference', 1.0,
             jsonb_build_object('ref', a.ref)
        FROM external_refs a
        JOIN tasks ta ON ta.tenant_id = a.tenant_id AND ta.id = a.task_id
        JOIN external_refs c ON c.tenant_id = a.tenant_id AND c.ref = a.ref AND c.task_id <> a.task_id
        JOIN tasks tc ON tc.tenant_id = c.tenant_id AND tc.id = c.task_id
       WHERE ta.source IN ${AGENT_SOURCES} AND tc.source IN ${CONNECTOR_SOURCES}
         AND ta.created_at >= ${since}
      ON CONFLICT (tenant_id, task_id, target_task_id) DO UPDATE
        SET method = 'reference', confidence = 1.0, evidence = EXCLUDED.evidence
      WHERE task_attributions.method <> 'reference'`);

    // Agent tasks with nothing attributed yet, and the connector tasks near them in time.
    const pairs = await tx.execute<{
      task_id: string;
      target_id: string;
      task_title: string;
      target_title: string;
      hours: number;
    }>(sql`
      SELECT a.id AS task_id, c.id AS target_id, a.title_redacted AS task_title,
             c.title_redacted AS target_title,
             extract(epoch FROM (c.started_at - coalesce(a.completed_at, a.created_at))) / 3600 AS hours
        FROM tasks a
        JOIN tasks c ON c.tenant_id = a.tenant_id AND c.member_id = a.member_id
       WHERE a.source IN ${AGENT_SOURCES} AND c.source IN ${CONNECTOR_SOURCES}
         AND a.member_id IS NOT NULL AND a.created_at >= ${since}
         AND c.started_at BETWEEN coalesce(a.completed_at, a.created_at) - make_interval(hours => ${HEURISTIC.beforeHours})
                              AND coalesce(a.completed_at, a.created_at) + make_interval(hours => ${HEURISTIC.afterHours})
         AND NOT EXISTS (SELECT 1 FROM task_attributions x WHERE x.task_id = a.id)`);
    const best = new Map<
      string,
      { target: string; confidence: number; similarity: number; hours: number }
    >();
    for (const p of pairs.rows) {
      const similarity = jaccard(titleWords(p.task_title), titleWords(p.target_title));
      const confidence = heuristicConfidence(Number(p.hours), similarity);
      const prev = best.get(p.task_id);
      if (confidence >= HEURISTIC.storeFrom && (!prev || confidence > prev.confidence)) {
        best.set(p.task_id, {
          target: p.target_id,
          confidence,
          similarity,
          hours: Number(p.hours),
        });
      }
    }
    for (const [taskId, b] of best) {
      await tx
        .insert(taskAttributions)
        .values({
          tenantId,
          taskId,
          targetTaskId: b.target,
          method: "heuristic",
          confidence: b.confidence,
          evidence: {
            hours: Math.round(b.hours * 10) / 10,
            title_similarity: Math.round(b.similarity * 100) / 100,
          },
        })
        .onConflictDoNothing();
    }
    return { reference: byRef.rowCount ?? 0, heuristic: best.size };
  });
}
