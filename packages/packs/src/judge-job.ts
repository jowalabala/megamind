// Judges tasks whose required metrics exist, against their pack's rules and the team's own
// recent baseline, and stores one judgment per task per ruleset version.
//
// Baselines use only tasks completed before the judged one (no lookahead) and the latest
// observation of each metric. Every judgment carries a hash of its inputs; replayJudgments()
// recomputes them and reports any that differ.
import { idFromKey, judgments, sql, tasks, eq, type MasterMindDb, type TenantTx } from "@mm/db";
import { enqueueLakeRecords, judgmentRecord } from "@mm/lake";
import { computeStats, inputHash, judge, type Baseline } from "./judge.ts";
import { judgeFor, judgeVersion, packJudges, type JudgeConfig, type Pack } from "./schema.ts";
import { resolvePacks, type PackSource } from "./tenant.ts";

export interface JudgeDeps {
  db: MasterMindDb;
  packs: PackSource;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

type Candidate = {
  id: string;
  category: string | null;
  completed_at: Date;
  member_id: string | null;
  actor_key: string | null;
  agent_identity_id: string | null;
  source: string;
};

const DAY = 86_400_000;

async function latestMetrics(tx: TenantTx, taskId: string): Promise<Record<string, number>> {
  const res = await tx.execute<{ metric_key: string; value: number }>(sql`
    SELECT DISTINCT ON (metric_key) metric_key, value FROM metric_observations
     WHERE task_id = ${taskId} ORDER BY metric_key, observed_at DESC, id`);
  return Object.fromEntries(res.rows.map((r) => [r.metric_key, Number(r.value)]));
}

/** The team's recent history for each baseline metric: same category if enough, else the pack. */
async function baselineFor(
  tx: TenantTx,
  pack: string,
  config: JudgeConfig,
  t: Candidate,
): Promise<Baseline> {
  const metrics = [
    ...new Set(
      [...config.success_if_all, ...config.failure_if_any]
        .filter((c) => c.baseline)
        .map((c) => c.metric),
    ),
  ];
  const until = new Date(t.completed_at);
  const from = new Date(until.getTime() - config.baseline.days * DAY);
  const out: Baseline = {};
  for (const metric of metrics) {
    const values = async (sameCategory: boolean) =>
      (
        await tx.execute<{ value: number }>(sql`
          SELECT DISTINCT ON (o.task_id) o.value FROM metric_observations o
            JOIN tasks x ON x.tenant_id = o.tenant_id AND x.id = o.task_id
           WHERE o.metric_key = ${metric} AND x.pack = ${pack} AND x.id <> ${t.id}
             AND x.completed_at >= ${from.toISOString()} AND x.completed_at < ${until.toISOString()}
             ${sameCategory ? sql`AND x.category IS NOT DISTINCT FROM ${t.category}` : sql``}
           ORDER BY o.task_id, o.observed_at DESC, o.id`)
      ).rows.map((r) => Number(r.value));
    let stats = computeStats(await values(true));
    if (!stats || stats.n < config.baseline.min_samples) stats = computeStats(await values(false));
    if (stats) out[metric] = stats;
  }
  return out;
}

function evaluateCandidate(
  pack: Pack,
  config: JudgeConfig,
  t: Candidate,
  metrics: Record<string, number>,
  baseline: Baseline,
) {
  const result = judge(config, { category: t.category, metrics }, baseline);
  if (!result) return null;
  const hash = inputHash({
    task: t.id,
    category: t.category,
    metrics,
    baseline,
    ruleset: { pack: pack.id, judge: config },
  });
  return { ...result, hash };
}

/** Judges up to `limit` tasks per pack. Returns how many judgments were written. */
export async function judgeSweep(deps: JudgeDeps, tenantId: string, limit = 200): Promise<number> {
  let written = 0;
  const { current } = await resolvePacks(deps.packs, tenantId);
  for (const pack of current) {
    for (const config of packJudges(pack)) {
      written += await sweepRuleSet(deps, tenantId, pack, config, limit);
    }
  }
  if (written) deps.log?.("judge.written", { tenantId, judgments: written });
  return written;
}

const sqlList = (xs: string[]) =>
  sql.join(
    xs.map((x) => sql`${x}`),
    sql`, `,
  );

/** Which tasks a rule set judges: its own categories, or (catch-all) the ones no other names. */
function categoryFilter(pack: Pack, config: JudgeConfig) {
  if (config.categories) return sql`AND t.category IN (${sqlList(config.categories)})`;
  const claimed = packJudges(pack).flatMap((j) => j.categories ?? []);
  const excluded = [...claimed, ...config.skip_categories];
  return excluded.length
    ? sql`AND (t.category IS NULL OR t.category NOT IN (${sqlList(excluded)}))`
    : sql``;
}

async function sweepRuleSet(
  deps: JudgeDeps,
  tenantId: string,
  pack: Pack,
  config: JudgeConfig,
  limit: number,
): Promise<number> {
  return deps.db.withTenant(tenantId, async (tx) => {
    const due = await tx.execute<Candidate>(sql`
        SELECT t.id, t.category, t.completed_at, t.member_id, t.actor_key, t.agent_identity_id, t.source
          FROM tasks t
         WHERE t.pack = ${pack.id} AND t.completed_at IS NOT NULL
           ${categoryFilter(pack, config)}
           AND NOT EXISTS (SELECT 1 FROM judgments j WHERE j.task_id = t.id
                             AND j.pack = ${pack.id} AND j.ruleset_version = ${config.version})
           AND (SELECT count(DISTINCT m.metric_key) FROM metric_observations m
                 WHERE m.task_id = t.id
                   AND m.metric_key IN (${sqlList(config.requires)}))
               = ${config.requires.length}
         ORDER BY t.completed_at, t.id
         LIMIT ${limit}`);
    let n = 0;
    for (const t of due.rows) {
      const metrics = await latestMetrics(tx, t.id);
      const baseline = await baselineFor(tx, pack.id, config, t);
      const result = evaluateCandidate(pack, config, t, metrics, baseline);
      if (!result) continue; // skipped category
      const id = idFromKey([t.id, "judgment", pack.id, String(config.version)]);
      // Event time is when the outcome became knowable, not wall-clock time: replays match.
      const judgedAt = new Date(t.completed_at);
      const inserted = await tx
        .insert(judgments)
        .values({
          id,
          tenantId,
          taskId: t.id,
          pack: pack.id,
          rulesetVersion: config.version,
          category: t.category,
          verdict: result.verdict,
          reasons: result.reasons,
          baseline: baseline as unknown as Record<string, Record<string, number>>,
          inputHash: result.hash,
        })
        .onConflictDoNothing()
        .returning({ id: judgments.id });
      if (!inserted.length) continue;
      await tx
        .update(tasks)
        .set({ state: "judged", updatedAt: new Date() })
        .where(eq(tasks.id, t.id));
      await enqueueLakeRecords(tx, tenantId, [
        judgmentRecord({
          id: idFromKey([id, result.hash]),
          tenantId,
          memberId: t.member_id,
          actorKey: t.actor_key,
          agentId: t.agent_identity_id,
          source: t.source as "github",
          taskId: t.id,
          pack: pack.id,
          rulesetVersion: config.version,
          category: t.category,
          verdict: result.verdict,
          reasons: result.reasons,
          baseline,
          inputHash: result.hash,
          judgedAt,
          ingestedAt: new Date(),
        }),
      ]);
      n++;
    }
    return n;
  });
}

export interface ReplayMismatch {
  taskId: string;
  stored: { verdict: string; inputHash: string };
  replayed: { verdict: string; inputHash: string } | null;
}

/** Recomputes every stored judgment from current data. Empty mismatches means identical. */
export async function replayJudgments(
  deps: Pick<JudgeDeps, "db" | "packs">,
  tenantId: string,
): Promise<{ checked: number; mismatches: ReplayMismatch[] }> {
  const { all } = await resolvePacks(deps.packs, tenantId);
  return deps.db.withTenant(tenantId, async (tx) => {
    const stored = await tx
      .select({
        taskId: judgments.taskId,
        pack: judgments.pack,
        version: judgments.rulesetVersion,
        verdict: judgments.verdict,
        inputHash: judgments.inputHash,
      })
      .from(judgments);
    const mismatches: ReplayMismatch[] = [];
    let checked = 0;
    for (const j of stored) {
      const pack = all.find((p) => p.id === j.pack && judgeVersion(p) === j.version);
      if (!pack) continue; // judged by a ruleset version no longer loaded
      const [t] = await tx
        .execute<Candidate>(
          sql`
        SELECT id, category, completed_at, member_id, actor_key, agent_identity_id, source
          FROM tasks WHERE id = ${j.taskId}`,
        )
        .then((r) => r.rows);
      checked++;
      const config = t ? judgeFor(pack, t.category) : null;
      const result =
        t && config
          ? evaluateCandidate(
              pack,
              config,
              t,
              await latestMetrics(tx, t.id),
              await baselineFor(tx, pack.id, config, t),
            )
          : null;
      if (!result || result.verdict !== j.verdict || result.hash !== j.inputHash) {
        mismatches.push({
          taskId: j.taskId,
          stored: { verdict: j.verdict, inputHash: j.inputHash },
          replayed: result ? { verdict: result.verdict, inputHash: result.hash } : null,
        });
      }
    }
    return { checked, mismatches };
  });
}
