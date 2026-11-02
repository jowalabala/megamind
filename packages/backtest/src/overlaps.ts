// Collaboration value, counterfactually: replay pull request history through the overlap
// rule (two people with open PRs changing the same file at the same time) and compare what
// happened to work that would have been flagged with work that wouldn't. File level only:
// line ranges aren't kept for historical PRs, so same_lines can't be replayed yet.
import { wilson, type Rate } from "./report.ts";

export interface HistoricalPr {
  id: string;
  repo: string;
  author: string;
  files: string[];
  openedAt: Date;
  /** Merged or closed; null if still open. */
  endedAt: Date | null;
  mergeConflict: boolean | null;
  escapedDefect: boolean | null;
}

export interface OverlapReplay {
  prs: number;
  flaggedPairs: number;
  flaggedPrs: number;
  /** Share of flagged pairs where at least one side then hit a merge conflict. */
  precision: Rate;
  conflicts: { flagged: Rate; unflagged: Rate };
  defects: { flagged: Rate; unflagged: Rate };
  /** Conflicts and defects in PRs an alert would have reached. */
  avoidable: { conflicts: number; defects: number };
}

export function replayOverlaps(
  prs: HistoricalPr[],
  options: { from?: Date; to?: Date; now?: Date } = {},
): OverlapReplay {
  const now = options.now ?? new Date();
  const inWindow = prs.filter(
    (p) =>
      (!options.from || p.openedAt >= options.from) && (!options.to || p.openedAt < options.to),
  );
  const flagged = new Set<string>();
  let pairs = 0;
  let warranted = 0;
  const byRepo = new Map<string, HistoricalPr[]>();
  for (const p of inWindow) byRepo.set(p.repo, [...(byRepo.get(p.repo) ?? []), p]);
  for (const list of byRepo.values()) {
    list.sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      const aEnd = (a.endedAt ?? now).getTime();
      const aFiles = new Set(a.files);
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]!;
        if (b.openedAt.getTime() >= aEnd) break; // sorted: no later PR overlaps a in time
        if (a.author === b.author) continue;
        if (!b.files.some((f) => aFiles.has(f))) continue;
        pairs++;
        flagged.add(a.id);
        flagged.add(b.id);
        if (a.mergeConflict || b.mergeConflict) warranted++;
      }
    }
  }
  const rate = (sel: HistoricalPr[], key: "mergeConflict" | "escapedDefect") => {
    const known = sel.filter((p) => p[key] !== null);
    return wilson(known.filter((p) => p[key]).length, known.length);
  };
  const f = inWindow.filter((p) => flagged.has(p.id));
  const u = inWindow.filter((p) => !flagged.has(p.id));
  return {
    prs: inWindow.length,
    flaggedPairs: pairs,
    flaggedPrs: f.length,
    precision: wilson(warranted, pairs),
    conflicts: { flagged: rate(f, "mergeConflict"), unflagged: rate(u, "mergeConflict") },
    defects: { flagged: rate(f, "escapedDefect"), unflagged: rate(u, "escapedDefect") },
    avoidable: {
      conflicts: f.filter((p) => p.mergeConflict).length,
      defects: f.filter((p) => p.escapedDefect).length,
    },
  };
}
