import { describe, expect, it } from "vitest";
import { builtinPacks, computeStats, inputHash, judge, parsePack } from "../src/index.ts";

const config = builtinPacks().find((p) => p.id === "engineering")!.judge!;
const baseline = { "pr.review_rounds": { n: 30, p25: 0, p50: 1, p75: 2, mean: 1.1 } };
const ok = { "pr.reverted": 0, "pr.escaped_defect": 0, "ci.first_pass": 1, "pr.review_rounds": 1 };

describe("judge", () => {
  it("success needs every success condition; any failure condition wins", () => {
    expect(judge(config, { category: "feature", metrics: ok }, baseline)!.verdict).toBe("success");
    expect(
      judge(config, { category: "feature", metrics: { ...ok, "pr.reverted": 1 } }, baseline)!
        .verdict,
    ).toBe("failure");
    expect(
      judge(config, { category: "bugfix", metrics: { ...ok, "pr.escaped_defect": 1 } }, baseline)!
        .verdict,
    ).toBe("failure");
  });

  it("neutral when nothing failed but the bar wasn't met", () => {
    const j = judge(
      config,
      { category: "feature", metrics: { ...ok, "pr.review_rounds": 3 } },
      baseline,
    )!;
    expect(j.verdict).toBe("neutral");
    expect(j.reasons.find((r) => r.metric === "pr.review_rounds")).toEqual({
      rule: "success_if_all",
      metric: "pr.review_rounds",
      value: 3,
      threshold: 2,
      result: "false",
    });
  });

  it("inconclusive without enough history or a metric, never a guess", () => {
    const thin = { "pr.review_rounds": { ...baseline["pr.review_rounds"], n: 19 } };
    expect(judge(config, { category: "feature", metrics: ok }, thin)!.verdict).toBe("inconclusive");
    const noCi: Record<string, number> = { ...ok };
    delete noCi["ci.first_pass"];
    expect(judge(config, { category: "feature", metrics: noCi }, baseline)!.verdict).toBe(
      "inconclusive",
    );
    // But a failure is still a failure.
    expect(
      judge(config, { category: "feature", metrics: { ...noCi, "pr.reverted": 1 } }, {})!.verdict,
    ).toBe("failure");
  });

  it("skips categories it doesn't judge, and tasks missing required metrics", () => {
    expect(judge(config, { category: "dependencies", metrics: ok }, baseline)).toBeNull();
    expect(
      judge(config, { category: "feature", metrics: { "ci.first_pass": 1 } }, baseline),
    ).toBeNull();
  });

  it("computes percentiles and hashes inputs stably", () => {
    expect(computeStats([3, 1, 2, 4])).toEqual({ n: 4, p25: 1.75, p50: 2.5, p75: 3.25, mean: 2.5 });
    expect(computeStats([])).toBeNull();
    expect(inputHash({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(
      inputHash({ a: [2, { c: 2, d: 1 }], b: 1 }),
    );
    expect(inputHash({ a: 1 })).not.toBe(inputHash({ a: 2 }));
  });

  it("rejects judge rules that are ambiguous", () => {
    expect(() =>
      parsePack(`
id: p
version: 1
name: P
categories: [{ id: a, name: A, description: a }]
fallback: a
judge:
  version: 1
  requires: [x.y]
  success_if_all: [{ metric: x.y, op: eq, value: 1, baseline: p50 }]
`),
    ).toThrow(/exactly one of value or baseline/);
  });
});
