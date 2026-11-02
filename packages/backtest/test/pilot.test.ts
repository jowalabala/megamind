import { describe, expect, it } from "vitest";
import {
  pitchBar,
  renderPilotReport,
  replayOverlaps,
  skillLift,
  type BacktestSkill,
  type HistoricalPr,
  type TestTask,
} from "../src/index.ts";

const DAY = 86_400_000;
const T = Date.UTC(2026, 3, 1);
const trainEnd = new Date(T);

const skill = (id: string, over: Partial<BacktestSkill> = {}): BacktestSkill => ({
  id,
  title: `Skill ${id}`,
  pack: "engineering",
  category: "bugfix",
  whenToUse: "fixing bugs",
  steps: ["write a failing test first"],
  learnedBefore: new Date(T - DAY),
  ...over,
});

/** 80 bug fixes after the split. Tasks with tests (even ids) mostly succeed. */
const tasks: TestTask[] = Array.from({ length: 80 }, (_, i) => ({
  id: `t${String(i).padStart(2, "0")}`,
  pack: "engineering",
  category: "bugfix",
  title: `Fix ${i}`,
  summary: "",
  features: { tests_touched: i % 2 === 0 },
  completedAt: new Date(T + i * DAY),
  verdict:
    i % 2 === 0 ? (i % 10 === 0 ? "failure" : "success") : i % 4 === 1 ? "success" : "failure",
}));
// The labeller sees features only, never the verdict.
const byTests = async (_s: BacktestSkill, t: TestTask) =>
  t.features.tests_touched ? ("followed" as const) : ("not_followed" as const);

describe("skillLift", () => {
  it("finds a real effect, and the placebo doesn't reproduce it", async () => {
    const l = await skillLift(skill("a"), tasks, byTests, { trainEnd });
    expect(l.labelled).toBe(80);
    expect(l.usedN).toBe(40);
    expect(l.status).toBe("improves");
    expect(l.lift).toBeCloseTo(0.8 - 0.5, 5);
    expect(Math.abs(l.placebo.mean!)).toBeLessThan(0.05);
    expect(l.placebo.p).toBeLessThan(0.05);
    expect(l.credible).toBe(true);
    // Same seed, same placebo: the report is reproducible.
    expect((await skillLift(skill("a"), tasks, byTests, { trainEnd })).placebo).toEqual(l.placebo);
  });

  it("a labeller unrelated to the work shows no credible lift", async () => {
    const coin = async (_s: BacktestSkill, t: TestTask) =>
      Number(t.id.slice(1)) % 3 === 0 ? ("followed" as const) : ("not_followed" as const);
    const l = await skillLift(skill("b"), tasks, coin, { trainEnd });
    expect(l.credible).toBe(false);
  });

  it("refuses skills learned after the split, and ignores work before it", async () => {
    await expect(
      skillLift(skill("c", { learnedBefore: new Date(T + DAY) }), tasks, byTests, { trainEnd }),
    ).rejects.toThrow(/lookahead/);
    const early = tasks.map((t) => ({ ...t, completedAt: new Date(T - DAY) }));
    expect((await skillLift(skill("d"), early, byTests, { trainEnd })).labelled).toBe(0);
  });
});

describe("replayOverlaps", () => {
  const pr = (
    id: string,
    author: string,
    files: string[],
    open: number,
    end: number,
    conflict: boolean,
  ): HistoricalPr => ({
    id,
    repo: "acme/api",
    author,
    files,
    openedAt: new Date(T + open * DAY),
    endedAt: new Date(T + end * DAY),
    mergeConflict: conflict,
    escapedDefect: false,
  });
  it("flags same-file work by different people at the same time", () => {
    const r = replayOverlaps(
      [
        pr("1", "dana", ["src/billing.ts"], 0, 3, true),
        pr("2", "lior", ["src/billing.ts", "README.md"], 1, 4, false),
        pr("3", "lior", ["src/billing.ts"], 5, 6, false), // after 1 ended
        pr("4", "dana", ["src/other.ts"], 1, 2, false), // different file
        pr("5", "dana", ["src/billing.ts"], 2, 3, false), // same author as 1
      ],
      { from: trainEnd },
    );
    // 1–2 (dana, lior) and 2–5 (lior, dana) overlap; 1–5 is the same person.
    expect(r.flaggedPairs).toBe(2);
    expect(r.flaggedPrs).toBe(3);
    expect(r.precision.rate).toBe(0.5);
    expect(r.avoidable.conflicts).toBe(1);
    expect(r.conflicts.unflagged.k).toBe(0);
  });
});

describe("renderPilotReport", () => {
  it("checks the pitch bar and says what wasn't run", async () => {
    const base = {
      tenantId: "x",
      trainEnd: trainEnd.toISOString(),
      tasks: 80,
      judged: 80,
      categories: {},
      contrasts: [],
    };
    const lifts = await Promise.all(
      ["a", "b", "c"].map((id) => skillLift(skill(id), tasks, byTests, { trainEnd })),
    );
    const overlaps = replayOverlaps([], {});
    const r = {
      base,
      lifts,
      overlaps: { ...overlaps, precision: { k: 7, n: 10, rate: 0.7, low: 0.4, high: 0.9 } },
      testFrom: trainEnd.toISOString(),
    };
    expect(pitchBar(r).met).toBe(true);
    const md = renderPilotReport(r);
    expect(md).toContain("**The pitch bar is met.**");
    expect(md).toContain("| Skill a | bugfix | 80 | 40 | +30 pts");
    expect(renderPilotReport({ ...r, lifts: null, overlaps: null })).toContain("Not run");
  });
});
