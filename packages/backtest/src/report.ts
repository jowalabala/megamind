// Backtest v0: what the lake says about outcomes, split into a training and a test window.
//
// Per category: how many tasks were judged, and success/failure rates with 95% Wilson
// intervals, so small samples look as uncertain as they are. Plus the features that differ
// most between successful and failed work in the training window: the raw material the
// week 6 skill extraction starts from. Reads only the lake (no lookahead: the split is by
// the time each outcome became known).
import type { LakeAdmin } from "@mm/lake";

export interface Rate {
  k: number;
  n: number;
  rate: number | null;
  low: number | null;
  high: number | null;
}

/** 95% Wilson score interval. */
export function wilson(k: number, n: number, z = 1.96): Rate {
  if (n === 0) return { k, n, rate: null, low: null, high: null };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    k,
    n,
    rate: r(p),
    low: r(Math.max(0, center - half)),
    high: r(Math.min(1, center + half)),
  };
}

export interface CategoryWindow {
  judged: number;
  verdicts: Record<string, number>;
  /** Over decided verdicts (success, failure, neutral); inconclusive excluded. */
  success: Rate;
  failure: Rate;
}

export interface FeatureContrast {
  feature: string;
  successMean: number;
  failureMean: number;
  /** Difference in means over the pooled standard deviation. */
  effect: number;
  nSuccess: number;
  nFailure: number;
}

export interface BacktestReport {
  tenantId: string;
  trainEnd: string;
  tasks: number;
  judged: number;
  categories: Record<string, { train: CategoryWindow; test: CategoryWindow }>;
  contrasts: FeatureContrast[];
}

type Row = Record<string, unknown>;

/** Latest row per task (by event_time, then ruleset version). */
function latestPerTask(rows: Row[]): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const r of rows) {
    const id = String(r.task_id);
    const cur = out.get(id);
    const newer =
      !cur ||
      Number(r.ruleset_version ?? 0) > Number(cur.ruleset_version ?? 0) ||
      (Number(r.ruleset_version ?? 0) === Number(cur.ruleset_version ?? 0) &&
        Date.parse(String(r.event_time)) > Date.parse(String(cur.event_time)));
    if (newer) out.set(id, r);
  }
  return out;
}

function window(verdicts: string[]): CategoryWindow {
  const count = (v: string) => verdicts.filter((x) => x === v).length;
  const decided = verdicts.filter((v) => v !== "inconclusive").length;
  return {
    judged: verdicts.length,
    verdicts: Object.fromEntries(
      ["success", "failure", "neutral", "inconclusive"].map((v) => [v, count(v)]),
    ),
    success: wilson(count("success"), decided),
    failure: wilson(count("failure"), decided),
  };
}

function parseJson(v: unknown): Record<string, unknown> {
  if (typeof v !== "string") return (v as Record<string, unknown>) ?? {};
  try {
    return JSON.parse(v) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function buildReport(
  lake: Pick<LakeAdmin, "scan">,
  tenantId: string,
  options: { trainEnd: Date; minGroup?: number },
): Promise<BacktestReport> {
  const [tasks, judgments] = await Promise.all([
    lake.scan(tenantId, "tasks"),
    lake.scan(tenantId, "judgments"),
  ]);
  const latest = latestPerTask(judgments);
  const taskById = new Map(tasks.map((t) => [String(t.event_id), t]));
  const trainEnd = options.trainEnd.getTime();

  const groups: Record<string, { train: string[]; test: string[] }> = {};
  const featureRows: { verdict: string; features: Record<string, unknown> }[] = [];
  for (const j of latest.values()) {
    const category = String(j.category ?? "uncategorized");
    const verdict = String(j.verdict);
    const inTrain = Date.parse(String(j.event_time)) < trainEnd;
    (groups[category] ??= { train: [], test: [] })[inTrain ? "train" : "test"].push(verdict);
    const task = taskById.get(String(j.task_id));
    if (inTrain && task) featureRows.push({ verdict, features: parseJson(task.features) });
  }

  const minGroup = options.minGroup ?? 5;
  const ok = featureRows.filter((r) => r.verdict === "success");
  const bad = featureRows.filter((r) => r.verdict === "failure");
  const contrasts: FeatureContrast[] = [];
  const names = new Set(featureRows.flatMap((r) => Object.keys(r.features)));
  for (const f of names) {
    const nums = (rows: typeof featureRows) =>
      rows
        .map((r) => r.features[f])
        .filter((v) => typeof v === "number" || typeof v === "boolean")
        .map(Number);
    const a = nums(ok);
    const b = nums(bad);
    if (a.length < minGroup || b.length < minGroup) continue;
    const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
    const varOf = (x: number[], m: number) =>
      x.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, x.length - 1);
    const ma = mean(a);
    const mb = mean(b);
    const pooled = Math.sqrt((varOf(a, ma) + varOf(b, mb)) / 2);
    if (pooled === 0 && ma === mb) continue;
    const r = (x: number) => Math.round(x * 100) / 100;
    contrasts.push({
      feature: f,
      successMean: r(ma),
      failureMean: r(mb),
      effect: r(pooled === 0 ? Math.sign(ma - mb) * 9.99 : (ma - mb) / pooled),
      nSuccess: a.length,
      nFailure: b.length,
    });
  }
  contrasts.sort((x, y) => Math.abs(y.effect) - Math.abs(x.effect));

  return {
    tenantId,
    trainEnd: options.trainEnd.toISOString(),
    tasks: tasks.length,
    judged: latest.size,
    categories: Object.fromEntries(
      Object.entries(groups)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([c, g]) => [c, { train: window(g.train), test: window(g.test) }]),
    ),
    contrasts: contrasts.slice(0, 10),
  };
}

const pct = (r: Rate) =>
  r.rate === null
    ? "—"
    : `${Math.round(r.rate * 100)}% (${Math.round(r.low! * 100)}–${Math.round(r.high! * 100)}%, n=${r.n})`;

export function renderMarkdown(r: BacktestReport): string {
  const lines = [
    `# Backtest v0`,
    "",
    `Tenant \`${r.tenantId}\`. Training window ends ${r.trainEnd.slice(0, 10)}. ${r.tasks} tasks in the lake, ${r.judged} judged.`,
    "",
    "## Outcomes by category",
    "",
    "Rates are over decided verdicts (inconclusive excluded), with 95% Wilson intervals.",
    "",
    "| Category | Train judged | Train success | Train failure | Test judged | Test success | Test failure |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...Object.entries(r.categories).map(
      ([c, w]) =>
        `| ${c} | ${w.train.judged} | ${pct(w.train.success)} | ${pct(w.train.failure)} | ${w.test.judged} | ${pct(w.test.success)} | ${pct(w.test.failure)} |`,
    ),
    "",
    "## What differs between success and failure (training window)",
    "",
  ];
  if (r.contrasts.length === 0) {
    lines.push("Not enough successes and failures yet (5 of each needed).");
  } else {
    lines.push(
      "| Feature | Success mean | Failure mean | Effect size |",
      "| --- | --- | --- | --- |",
    );
    for (const c of r.contrasts) {
      lines.push(`| ${c.feature} | ${c.successMean} | ${c.failureMean} | ${c.effect} |`);
    }
    lines.push(
      "",
      "Effect size is the difference in means over the pooled standard deviation. Correlation, not cause.",
    );
  }
  return lines.join("\n") + "\n";
}
