// The judge: a pure function from (metrics, baseline, rules) to a verdict with reasons.
// No clock, no I/O, so the same inputs always give the same judgment.
import { createHash } from "node:crypto";
import type { Condition, JudgeConfig } from "./schema.ts";

export type Verdict = "success" | "failure" | "neutral" | "inconclusive";

export interface MetricStats {
  n: number;
  p25: number;
  p50: number;
  p75: number;
  mean: number;
}
export type Baseline = Record<string, MetricStats>;

export interface Reason {
  rule: "failure_if_any" | "success_if_all";
  metric: string;
  value: number | null;
  threshold: number | null;
  result: "true" | "false" | "unknown";
}

export interface Judgment {
  verdict: Verdict;
  reasons: Reason[];
}

/** Linear-interpolated percentile of sorted values. */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

const round = (x: number) => Math.round(x * 1000) / 1000;

export function computeStats(values: number[]): MetricStats | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    p25: round(percentile(s, 0.25)),
    p50: round(percentile(s, 0.5)),
    p75: round(percentile(s, 0.75)),
    mean: round(s.reduce((a, b) => a + b, 0) / s.length),
  };
}

function compare(op: Condition["op"], a: number, b: number): boolean {
  switch (op) {
    case "eq":
      return a === b;
    case "ne":
      return a !== b;
    case "lt":
      return a < b;
    case "lte":
      return a <= b;
    case "gt":
      return a > b;
    case "gte":
      return a >= b;
  }
}

function evaluate(
  rule: Reason["rule"],
  c: Condition,
  metrics: Record<string, number>,
  baseline: Baseline,
  minSamples: number,
): Reason {
  const value = metrics[c.metric] ?? null;
  let threshold: number | null = c.value ?? null;
  if (c.baseline) {
    const stats = baseline[c.metric];
    threshold = stats && stats.n >= minSamples ? stats[c.baseline] : null;
  }
  const result =
    value === null || threshold === null
      ? "unknown"
      : compare(c.op, value, threshold)
        ? "true"
        : "false";
  return { rule, metric: c.metric, value, threshold, result };
}

/** Null when the task isn't judged (skipped category, or required metrics missing). */
export function judge(
  config: JudgeConfig,
  task: { category: string | null; metrics: Record<string, number> },
  baseline: Baseline,
): Judgment | null {
  if (task.category && config.skip_categories.includes(task.category)) return null;
  if (config.requires.some((m) => task.metrics[m] === undefined)) return null;
  const min = config.baseline.min_samples;
  const failures = config.failure_if_any.map((c) =>
    evaluate("failure_if_any", c, task.metrics, baseline, min),
  );
  const successes = config.success_if_all.map((c) =>
    evaluate("success_if_all", c, task.metrics, baseline, min),
  );
  const reasons = [...failures, ...successes];
  let verdict: Verdict;
  if (failures.some((r) => r.result === "true")) verdict = "failure";
  else if (successes.every((r) => r.result === "true")) verdict = "success";
  else if (successes.some((r) => r.result === "unknown")) verdict = "inconclusive";
  else verdict = "neutral";
  return { verdict, reasons };
}

/** Stable JSON (sorted keys) for hashing. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function inputHash(parts: unknown): string {
  return createHash("sha256").update(canonical(parts)).digest("hex");
}
