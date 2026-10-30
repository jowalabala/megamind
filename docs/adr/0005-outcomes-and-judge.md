# ADR 0005: PR outcomes, the judge and backtest v0

**Status:** accepted, week 5. Checked on a synthetic labelled history; the pilot's 50 hand-labelled
PRs are the real test.

## Decision

### Outcome signals (engineering pack)

| Metric              | How                                                                                                                             | Final after |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `ci.first_pass`     | CI state of the PR's first commit                                                                                               | merge       |
| `pr.reverted`       | A merged PR within 30 days says it reverts it ("Reverts org/repo#N", "This reverts commit <sha>", or titled `Revert "<title>"`) | 30 days     |
| `pr.escaped_defect` | SZZ-lite: a bug fix merged within 60 days changed lines this PR last wrote                                                      | 60 days     |
| `pr.review_rounds`  | Reviews by others that requested changes                                                                                        | merge       |
| `pr.hours_to_merge` | Opened to merged                                                                                                                | merge       |
| `pr.merge_conflict` | A commit message mentions resolving conflicts (a proxy)                                                                         | merge       |

**SZZ-lite** works on merged PRs categorized as bug or security fixes:

1. Read the diff in memory.
2. Take the existing lines it removed or changed. Blank and comment-only lines, tests, docs and
   new files are skipped.
3. Ask GitHub's blame, at the fix's base commit, which PR last wrote each line.

PRs merged in the 60 days before the fix are linked as "fixed by" it. Only the link and its
counts (files, lines) are stored, never code.

### Metrics are written once, when mature

A PR's metrics are computed together, once all of these hold:

- it is 60 days past merge;
- its connection's history import is complete;
- every PR merged in its window has been categorized, and every fix among them traced.

Nothing is written earlier, so nothing is ever revised. Each metric's observation time is the
moment it became final, not the wall clock.

### The judge

The rules live in the pack and are versioned. The judge is a pure function of the task's
metrics, the team's baseline and the rules, so it has no clock and no I/O.

| Verdict      | When                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Failure      | Any failure condition holds (engineering: reverted, or an escaped defect).                                                   |
| Success      | Every success condition holds (engineering: CI passed first time, and review rounds at or below the team's 75th percentile). |
| Inconclusive | A success condition can't be evaluated: a metric is missing, or there are fewer than 20 comparable tasks.                    |
| Neutral      | Otherwise.                                                                                                                   |

**Baselines** use only tasks completed before the judged one, within the previous 180 days. They
use the same category when it has 20 or more samples, and the whole pack otherwise.

**Judgments** are stored once per task per ruleset version, with a hash of every input.
`replayJudgments` recomputes them and lists any that differ.

**Not judged:** reverts, dependency bumps, docs and chores.

### Backtest v0

`pnpm --filter @mm/backtest backtest <tenant>` reads only the lake (local files or Athena) and
reports, for a training and a test window:

- per category, success and failure rates with 95% Wilson intervals;
- the PR features that differ most between success and failure in the training window.

`label-agreement` compares a CSV of hand labels with what the system computed.

## Results on the synthetic history

The history is about 60 PRs with ground truth. It includes cases built to fool the signals:

- an add-only fix, so there is nothing to blame;
- a refactor that takes the blame for an older bug;
- an undo that doesn't say what it reverts.

Agreement on 50 judged PRs: **96% overall, 92% on verdicts**. Per label: CI first pass 100%,
reverted 98%, escaped defect 94%. Every disagreement is one of the built-in traps. Judging from
scratch twice gives identical judgments.

## Known limits

- **SZZ misses** fixes that only add code, and blames refactors that rewrote buggy lines.
  Literature puts plain SZZ precision around 60–70%; the pilot's labels will tell us where we are.
- **Merge conflicts** are a commit-message proxy. GitHub doesn't keep conflict history.
- **One judgment per ruleset version.** A late-arriving metric doesn't re-judge a task. That's
  safe in practice, because metrics are only written once mature.
