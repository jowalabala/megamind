// SZZ-lite: which earlier PRs did a bug fix repair?
//
// For a merged fix PR: read its diff, take the existing lines it removed or changed (skipping
// blank and comment-only lines, tests and docs), ask GitHub's blame which commit last wrote each
// of those lines as of the fix's base commit, and map those commits to their PRs. A PR merged in
// the window before the fix is linked as "fixed by" it.
//
// The diff and the blamed code are only read in memory. What's stored is the link plus counts.
import { DOC_FILE, TEST_FILE } from "./features.ts";
import type { InstallationClient } from "./client.ts";

/** Old-side line numbers the patch removes or replaces, ignoring blank and comment-only lines. */
export function changedOldLines(patch: string): number[] {
  const lines: number[] = [];
  let old = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (hunk) {
      old = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("-")) {
      const code = line.slice(1).trim();
      const meaningful = code !== "" && !/^(\/\/|#|\/\*|\*|<!--|--\s)/.test(code);
      if (meaningful) lines.push(old);
      old++;
    } else if (line.startsWith(" ")) {
      old++;
    }
    // "+" lines and "\ No newline" don't move the old side.
  }
  return lines;
}

export const BLAME_QUERY = `
query Blame($owner: String!, $name: String!, $oid: GitObjectID!, $path: String!) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) {
      ... on Commit {
        blame(path: $path) {
          ranges {
            startingLine endingLine
            commit { oid associatedPullRequests(first: 1) { nodes { number mergedAt } } }
          }
        }
      }
    }
  }
}`;

interface BlameResult {
  repository: {
    object: {
      blame?: {
        ranges: {
          startingLine: number;
          endingLine: number;
          commit: {
            oid: string;
            associatedPullRequests: { nodes: { number: number; mergedAt: string | null }[] };
          };
        }[];
      };
    } | null;
  } | null;
}

export interface FixTrace {
  /** PR number -> how much of the fix pointed at it. */
  introducing: Map<number, { files: number; lines: number }>;
  filesExamined: number;
  linesExamined: number;
}

export const SZZ_LIMITS = { files: 10, lines: 200, windowDays: 60 };

export async function traceFix(
  gh: InstallationClient,
  fix: { fullName: string; number: number; baseSha: string; mergedAt: Date },
): Promise<FixTrace> {
  const [owner, name] = fix.fullName.split("/");
  const files = await gh.rest<{ filename: string; status: string; patch?: string }[]>(
    "GET",
    `/repos/${owner}/${name}/pulls/${fix.number}/files?per_page=100`,
  );
  const candidates = files.filter(
    (f) =>
      f.patch &&
      f.status !== "added" &&
      !TEST_FILE.some((r) => r.test(f.filename)) &&
      !DOC_FILE.some((r) => r.test(f.filename)),
  );

  const introducing = new Map<number, { files: number; lines: number }>();
  const earliest = fix.mergedAt.getTime() - SZZ_LIMITS.windowDays * 86_400_000;
  let filesExamined = 0;
  let linesExamined = 0;
  for (const f of candidates.slice(0, SZZ_LIMITS.files)) {
    const lines = changedOldLines(f.patch!).slice(0, SZZ_LIMITS.lines - linesExamined);
    if (lines.length === 0) continue;
    filesExamined++;
    linesExamined += lines.length;
    const res = await gh.graphql<BlameResult>(BLAME_QUERY, {
      owner,
      name,
      oid: fix.baseSha,
      path: f.filename,
    });
    const ranges = res.repository?.object?.blame?.ranges ?? [];
    const perFile = new Map<number, number>();
    for (const line of lines) {
      const range = ranges.find((r) => r.startingLine <= line && line <= r.endingLine);
      const pr = range?.commit.associatedPullRequests.nodes[0];
      if (!pr?.mergedAt || pr.number === fix.number) continue;
      const merged = Date.parse(pr.mergedAt);
      if (merged >= fix.mergedAt.getTime() || merged < earliest) continue;
      perFile.set(pr.number, (perFile.get(pr.number) ?? 0) + 1);
    }
    for (const [pr, n] of perFile) {
      const cur = introducing.get(pr) ?? { files: 0, lines: 0 };
      introducing.set(pr, { files: cur.files + 1, lines: cur.lines + n });
    }
    if (linesExamined >= SZZ_LIMITS.lines) break;
  }
  return { introducing, filesExamined, linesExamined };
}
