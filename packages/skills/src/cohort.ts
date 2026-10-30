// Cohorts: for each category, the successful work and comparable unsuccessful work from a
// training window, read only from the lake (so a backtest can never see the future).
//
// Comparable means same category and similar size: each success is paired with the nearest
// unused failure by lines changed, then neutral results fill any gap. The feature hints say
// what differs between the two sides; the model gets them as leads, not conclusions.
import type { LakeAdmin } from "@mm/lake";

export interface CohortTask {
  taskId: string;
  /** Short id the model cites: S1.., F1.. */
  ref: string;
  verdict: string;
  title: string;
  summary: string;
  features: Record<string, number | boolean | string | null>;
  completedAt: string;
}

export interface FeatureHint {
  feature: string;
  successMean: number;
  failureMean: number;
}

export interface Cohort {
  pack: string;
  category: string;
  windowFrom: string | null;
  windowTo: string;
  success: CohortTask[];
  failure: CohortTask[];
  hints: FeatureHint[];
  /** Judged tasks in the category in the window (all verdicts but inconclusive). */
  decided: number;
}

export interface CohortOptions {
  trainEnd: Date;
  trainFrom?: Date;
  minSuccess?: number;
  minDecided?: number;
  maxPerSide?: number;
}

type Row = Record<string, unknown>;

function json(v: unknown): Record<string, unknown> {
  if (typeof v !== "string") return (v as Record<string, unknown>) ?? {};
  try {
    return JSON.parse(v) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const size = (t: CohortTask) => Number(t.features.size_lines ?? 0);

export async function buildCohorts(
  lake: Pick<LakeAdmin, "scan">,
  tenantId: string,
  options: CohortOptions,
): Promise<Cohort[]> {
  const minSuccess = options.minSuccess ?? 5;
  const minDecided = options.minDecided ?? 20;
  const maxPerSide = options.maxPerSide ?? 15;
  const range = { from: options.trainFrom, to: options.trainEnd };
  const [judgments, tasks] = await Promise.all([
    lake.scan(tenantId, "judgments", range),
    lake.scan(tenantId, "tasks"),
  ]);
  const taskById = new Map(tasks.map((t) => [String(t.event_id), t]));

  // Latest judgment per task.
  const latest = new Map<string, Row>();
  for (const j of judgments) {
    const id = String(j.task_id);
    const cur = latest.get(id);
    if (!cur || Number(j.ruleset_version) > Number(cur.ruleset_version)) latest.set(id, j);
  }

  const groups = new Map<string, { pack: string; category: string; rows: Row[] }>();
  for (const j of latest.values()) {
    if (j.verdict === "inconclusive" || !j.category) continue;
    const key = `${j.pack}/${j.category}`;
    if (!groups.has(key))
      groups.set(key, { pack: String(j.pack), category: String(j.category), rows: [] });
    groups.get(key)!.rows.push(j);
  }

  const cohorts: Cohort[] = [];
  for (const g of [...groups.values()].sort((a, b) =>
    `${a.pack}/${a.category}`.localeCompare(`${b.pack}/${b.category}`),
  )) {
    const toTask = (j: Row): CohortTask | null => {
      const t = taskById.get(String(j.task_id));
      if (!t) return null;
      const features = json(t.features) as CohortTask["features"];
      return {
        taskId: String(j.task_id),
        ref: "",
        verdict: String(j.verdict),
        title: String(t.title ?? ""),
        summary: String(t.summary ?? "").slice(0, 600),
        features,
        completedAt: String(j.event_time),
      };
    };
    const all = g.rows
      .map(toTask)
      .filter((t): t is CohortTask => t !== null)
      // Deterministic order: by time, then id.
      .sort(
        (a, b) => a.completedAt.localeCompare(b.completedAt) || a.taskId.localeCompare(b.taskId),
      );
    const success = all.filter((t) => t.verdict === "success");
    if (success.length < minSuccess || all.length < minDecided) continue;

    // Most recent successes first (closest to current practice).
    const s = success.slice(-maxPerSide);
    const pool = [
      ...all.filter((t) => t.verdict === "failure"),
      ...all.filter((t) => t.verdict === "neutral"),
    ];
    const f: CohortTask[] = [];
    for (const x of s) {
      if (f.length >= maxPerSide || pool.length === 0) break;
      // Prefer failures; among them the closest in size.
      const failures = pool.filter((p) => p.verdict === "failure");
      const candidates = failures.length ? failures : pool;
      candidates.sort(
        (a, b) =>
          Math.abs(size(a) - size(x)) - Math.abs(size(b) - size(x)) ||
          a.taskId.localeCompare(b.taskId),
      );
      const pick = candidates[0]!;
      f.push(pick);
      pool.splice(pool.indexOf(pick), 1);
    }
    s.forEach((t, i) => (t.ref = `S${i + 1}`));
    f.forEach((t, i) => (t.ref = `F${i + 1}`));

    const hints: FeatureHint[] = [];
    const names = new Set([...s, ...f].flatMap((t) => Object.keys(t.features)));
    for (const name of [...names].sort()) {
      const nums = (ts: CohortTask[]) =>
        ts
          .map((t) => t.features[name])
          .filter((v) => typeof v === "number" || typeof v === "boolean")
          .map(Number);
      const a = nums(s);
      const b = nums(f);
      if (a.length < 3 || b.length < 3) continue;
      const mean = (x: number[]) =>
        Math.round((x.reduce((p, v) => p + v, 0) / x.length) * 100) / 100;
      const [ma, mb] = [mean(a), mean(b)];
      const scale = Math.max(Math.abs(ma), Math.abs(mb), 1e-9);
      if (Math.abs(ma - mb) / scale >= 0.2)
        hints.push({ feature: name, successMean: ma, failureMean: mb });
    }

    cohorts.push({
      pack: g.pack,
      category: g.category,
      windowFrom: options.trainFrom?.toISOString() ?? null,
      windowTo: options.trainEnd.toISOString(),
      success: s,
      failure: f,
      hints: hints.slice(0, 10),
      decided: all.length,
    });
  }
  return cohorts;
}
