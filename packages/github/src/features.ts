// Structured PR features (the engineering pack's feature list). Computed from metadata and
// the raw body before redaction; only the numbers and flags are kept.
import type { NormalizedPr } from "./normalize.ts";

export const TEST_FILE = [
  /(^|\/)(tests?|__tests__|specs?)\//i,
  /\.(test|spec)\.[a-z0-9]+$/i,
  /_test\.(go|py|rb)$/i,
  /(^|\/)test_[^/]+\.py$/i,
];
export const DOC_FILE = [/\.(md|mdx|rst|adoc|txt)$/i, /^docs?\//i];
/** Trailers and footers coding agents add; and bots named after them. */
const AGENT_MARKERS = [
  /co-authored-by:\s*(claude|copilot|cursor|devin|codex|aider)/i,
  /generated with \[?(claude code|cursor|copilot|codex)/i,
];
const AGENT_BOTS = /^(claude|copilot|devin|codex|cursor|sweep|aider)/i;

const hours = (a: Date, b: Date | null | undefined) =>
  b ? Math.round(((b.getTime() - a.getTime()) / 3_600_000) * 100) / 100 : null;

export type PrFeatures = Record<string, number | boolean | string | null>;

export function prFeatures(pr: NormalizedPr): PrFeatures {
  const files = pr.files.map((f) => f.path);
  const isTest = (f: string) => TEST_FILE.some((r) => r.test(f));
  const tests = files.filter(isTest).length;
  const submitted = pr.reviews
    .filter((r) => r.submittedAt && r.authorKey !== pr.author.key)
    .map((r) => new Date(r.submittedAt!))
    .sort((a, b) => a.getTime() - b.getTime());
  return {
    size_lines: pr.additions + pr.deletions,
    files_changed: pr.changedFiles,
    tests_touched: tests > 0,
    test_file_ratio: files.length ? Math.round((tests / files.length) * 100) / 100 : 0,
    docs_only: files.length > 0 && files.every((f) => DOC_FILE.some((r) => r.test(f))),
    dirs_touched: new Set(files.map((f) => (f.includes("/") ? f.split("/")[0] : "."))).size,
    commits: pr.commits,
    reviews: pr.reviews.length,
    reviewers: new Set(pr.reviews.map((r) => r.authorKey).filter((k) => k !== pr.author.key)).size,
    changes_requested: pr.reviews.filter((r) => r.state === "CHANGES_REQUESTED").length,
    hours_to_first_review: hours(pr.openedAt, submitted[0]),
    hours_to_merge: hours(pr.openedAt, pr.mergedAt),
    has_linked_issue: pr.closingIssues.length > 0,
    agent_authored:
      AGENT_MARKERS.some((r) => r.test(pr.body)) ||
      (pr.author.isBot && AGENT_BOTS.test(pr.author.login ?? "")),
    draft: pr.draft,
    ci_state: pr.ciState,
  };
}
