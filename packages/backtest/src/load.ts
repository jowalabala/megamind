// Loads what the pilot backtest needs: test-window work and verdicts from the lake, skills
// learned from the training window and pull request history from Postgres.
import {
  and,
  eq,
  githubPullRequests,
  lte,
  metricObservations,
  sql,
  skillDrafts,
  type MasterMindDb,
} from "@mm/db";
import type { LakeAdmin } from "@mm/lake";
import type { BacktestSkill, TestTask } from "./lift.ts";
import type { HistoricalPr } from "./overlaps.ts";

type Row = Record<string, unknown>;
const json = (v: unknown): Record<string, unknown> => {
  if (typeof v !== "string") return (v as Record<string, unknown>) ?? {};
  try {
    return JSON.parse(v) as Record<string, unknown>;
  } catch {
    return {};
  }
};
const latest = (rows: Row[], key: string, order: (r: Row) => number) => {
  const out = new Map<string, Row>();
  for (const r of rows) {
    const k = String(r[key]);
    const cur = out.get(k);
    if (!cur || order(r) > order(cur)) out.set(k, r);
  }
  return out;
};

/** Decided work completed on or after `trainEnd`, with its category and verdict. */
export async function loadTestTasks(
  lake: Pick<LakeAdmin, "scan">,
  tenantId: string,
  trainEnd: Date,
): Promise<TestTask[]> {
  const [tasks, categories, judgments] = await Promise.all([
    lake.scan(tenantId, "tasks"),
    lake.scan(tenantId, "task_categories"),
    lake.scan(tenantId, "judgments"),
  ]);
  const at = (r: Row) => Date.parse(String(r.event_time));
  const cat = latest(categories, "task_id", at);
  const verdict = latest(
    judgments,
    "task_id",
    (r) => Number(r.ruleset_version ?? 0) * 1e13 + at(r),
  );
  const out: TestTask[] = [];
  for (const t of tasks) {
    const id = String(t.event_id);
    const j = verdict.get(id);
    const v = String(j?.verdict ?? "");
    if (v !== "success" && v !== "failure" && v !== "neutral") continue;
    const completedAt = new Date(String(t.completed_at ?? t.event_time));
    if (completedAt < trainEnd) continue;
    const c = cat.get(id);
    const features = json(t.features);
    delete features.labels; // categorization input, not a description of the work
    out.push({
      id,
      pack: (c?.pack as string) ?? (j?.pack as string) ?? null,
      category: (c?.category as string) ?? (j?.category as string) ?? null,
      title: String(t.title ?? ""),
      summary: String(t.summary ?? ""),
      features,
      completedAt,
      verdict: v,
    });
  }
  return out;
}

/** Skill drafts generated from data that ended before `trainEnd` (none rejected). */
export async function loadBacktestSkills(
  db: MasterMindDb,
  tenantId: string,
  trainEnd: Date,
): Promise<BacktestSkill[]> {
  const rows = await db.withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(skillDrafts)
      .where(and(lte(skillDrafts.windowTo, trainEnd), sql`${skillDrafts.status} <> 'rejected'`)),
  );
  return rows.map((d) => ({
    id: d.id,
    title: d.title,
    pack: d.pack,
    category: d.category,
    whenToUse: d.body.when_to_use,
    steps: d.body.steps.map((s) => s.text),
    learnedBefore: d.windowTo,
  }));
}

/** Human-authored pull requests with their files and conflict and defect outcomes. */
export async function loadPrHistory(db: MasterMindDb, tenantId: string): Promise<HistoricalPr[]> {
  return db.withTenant(tenantId, async (tx) => {
    const prs = await tx
      .select({
        taskId: githubPullRequests.taskId,
        repo: githubPullRequests.repo,
        author: githubPullRequests.authorKey,
        files: githubPullRequests.files,
        openedAt: githubPullRequests.openedAt,
        mergedAt: githubPullRequests.mergedAt,
        closedAt: githubPullRequests.closedAt,
      })
      .from(githubPullRequests)
      .where(eq(githubPullRequests.authorIsBot, false));
    const metrics = await tx
      .select({
        taskId: metricObservations.taskId,
        key: metricObservations.metricKey,
        value: metricObservations.value,
        at: metricObservations.observedAt,
      })
      .from(metricObservations)
      .where(sql`${metricObservations.metricKey} IN ('pr.merge_conflict', 'pr.escaped_defect')`);
    const m = new Map<string, { at: number; value: number }>();
    for (const x of metrics) {
      const k = `${x.taskId}:${x.key}`;
      const cur = m.get(k);
      if (!cur || x.at.getTime() > cur.at) m.set(k, { at: x.at.getTime(), value: x.value });
    }
    const flag = (id: string, key: string) => {
      const v = m.get(`${id}:${key}`);
      return v ? v.value === 1 : null;
    };
    return prs.map((p) => ({
      id: p.taskId,
      repo: p.repo,
      author: p.author,
      files: p.files.map((f) => f.path),
      openedAt: p.openedAt,
      endedAt: p.mergedAt ?? p.closedAt,
      mergeConflict: flag(p.taskId, "pr.merge_conflict"),
      escapedDefect: flag(p.taskId, "pr.escaped_defect"),
    }));
  });
}
