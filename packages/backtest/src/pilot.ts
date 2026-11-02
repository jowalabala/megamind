// The pilot backtest report: outcomes by category, skill lift with its placebo, and what
// overlap alerts would have caught, with the pitch bar from the plan checked at the top.
import type { SkillLift } from "./lift.ts";
import type { OverlapReplay } from "./overlaps.ts";
import { renderMarkdown, type BacktestReport, type Rate } from "./report.ts";

export const PITCH_BAR = { credibleSkills: 3, overlapPrecision: 0.6 };

export interface PilotReport {
  base: BacktestReport;
  lifts: SkillLift[] | null;
  overlaps: OverlapReplay | null;
  testFrom: string;
}

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const signed = (x: number | null) =>
  x === null ? "—" : `${x > 0 ? "+" : ""}${Math.round(x * 1000) / 10} pts`;
const rate = (r: Rate) =>
  r.rate === null ? "—" : `${pct(r.rate)} (${pct(r.low)}–${pct(r.high)}, n=${r.n})`;

export function pitchBar(r: PilotReport) {
  const credible = r.lifts?.filter((l) => l.credible).length ?? null;
  const placeboClean =
    r.lifts === null
      ? null
      : r.lifts.every((l) => l.placebo.mean === null || Math.abs(l.placebo.mean) < 0.02);
  const precision = r.overlaps?.precision.rate ?? null;
  return {
    credible,
    placeboClean,
    precision,
    avoidable: r.overlaps?.avoidable ?? null,
    met:
      credible !== null &&
      credible >= PITCH_BAR.credibleSkills &&
      placeboClean === true &&
      precision !== null &&
      precision >= PITCH_BAR.overlapPrecision,
  };
}

export function renderPilotReport(r: PilotReport): string {
  const bar = pitchBar(r);
  const lines = [
    "# Pilot backtest",
    "",
    `Learned from work before ${r.base.trainEnd.slice(0, 10)}; tested on work from ${r.testFrom.slice(0, 10)} on. Nothing from the test window was used to learn skills or set baselines.`,
    "",
    "## Summary",
    "",
    "| Check | Result | Bar |",
    "| --- | --- | --- |",
    `| Skills with significant lift (and a clean placebo) | ${bar.credible ?? "not run"} | ≥ ${PITCH_BAR.credibleSkills} |`,
    `| Placebo (shuffled labels) shows no lift | ${bar.placeboClean === null ? "not run" : bar.placeboClean ? "yes" : "no"} | yes |`,
    `| Overlap alert precision (file level) | ${bar.precision === null ? "not run" : pct(bar.precision)} | ≥ ${pct(PITCH_BAR.overlapPrecision)} |`,
    `| Conflicts / defects in work an alert would have reached | ${bar.avoidable ? `${bar.avoidable.conflicts} / ${bar.avoidable.defects}` : "not run"} | a clear count |`,
    "",
    bar.met
      ? "**The pitch bar is met.**"
      : "The pitch bar is not met yet; see the sections below for what's short.",
    "",
    "## Skill lift on the test window",
    "",
  ];
  if (!r.lifts) {
    lines.push("Not run (needs the labeller: Claude Haiku on Bedrock).");
  } else if (r.lifts.length === 0) {
    lines.push("No skills were learned from the training window.");
  } else {
    lines.push(
      "Each test-window task in the skill's category was labelled followed or not by a model that never saw outcomes. Lift is the difference in success rates, with a 95% Agresti-Caffo interval. The placebo shuffles the labels 200 times: p is the share of shuffles with a lift at least as large.",
      "",
      "| Skill | Category | Labelled | Followed | Lift | 95% interval | Placebo mean | Placebo p | Verdict |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ...r.lifts.map(
        (l) =>
          `| ${l.title} | ${l.category} | ${l.labelled} | ${l.usedN} | ${signed(l.lift)} | ${
            l.ciLow === null ? "—" : `${signed(l.ciLow)} to ${signed(l.ciHigh)}`
          } | ${signed(l.placebo.mean)} | ${l.placebo.p ?? "—"} | ${
            l.credible ? "**improves**" : l.status.replace("_", " ")
          } |`,
      ),
      "",
      "Followed-vs-not is a comparison, not an experiment: people who follow a practice may differ in other ways. The pilot's staggered rollout is the stronger test.",
    );
  }
  lines.push("", "## What overlap alerts would have caught", "");
  if (!r.overlaps) {
    lines.push("Not run (needs GitHub history).");
  } else {
    const o = r.overlaps;
    lines.push(
      `Pull request history replayed through the overlap rule: two people with open pull requests changing the same file at the same time. ${o.prs} pull requests in the test window; ${o.flaggedPairs} pairs (${o.flaggedPrs} pull requests) would have been flagged.`,
      "",
      "| | Flagged | Not flagged |",
      "| --- | --- | --- |",
      `| Merge conflicts | ${rate(o.conflicts.flagged)} | ${rate(o.conflicts.unflagged)} |`,
      `| Escaped defects | ${rate(o.defects.flagged)} | ${rate(o.defects.unflagged)} |`,
      "",
      `Precision: ${rate(o.precision)} of flagged pairs went on to a merge conflict. An alert would have reached ${o.avoidable.conflicts} pull request(s) that hit merge conflicts and ${o.avoidable.defects} that shipped a defect.`,
      "",
      "Line-level overlaps (the strongest alert) can't be replayed from history yet, because changed line ranges weren't kept for past pull requests; live alerts use them.",
    );
  }
  lines.push("", renderMarkdown(r.base).replace(/^# Backtest v0\n/, "## Outcomes in detail\n"));
  return lines.join("\n");
}
