// GitHub's PR shape -> ours. Authors become actor keys ("github:<numeric id>"), never logins.
import type { GqlActor, GqlPr } from "./queries.ts";

export interface NormalizedPr {
  repoId: number;
  /** owner/name, lowercased. */
  repo: string;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  author: { key: string; githubUserId: number | null; isBot: boolean; login: string | null };
  baseRef: string;
  headRef: string;
  headSha: string | null;
  mergeCommitSha: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  labels: string[];
  files: { path: string; additions: number; deletions: number }[];
  reviews: { state: string; authorKey: string; submittedAt: string | null }[];
  closingIssues: number[];
  ciState: string | null;
  /** CI state of the first commit: did it pass the first time? */
  firstCiState: string | null;
  baseSha: string | null;
  /** PRs and commits this PR says it reverts. */
  revertsPrs: number[];
  revertsShas: string[];
  conflictCommits: number;
  baseMergeCommits: number;
  openedAt: Date;
  mergedAt: Date | null;
  closedAt: Date | null;
  updatedAt: Date;
}

export function actorKey(a: GqlActor | null): string {
  if (!a) return "github:ghost";
  if (a.__typename === "Bot")
    return `github:bot-${a.login.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 56)}`;
  if (a.databaseId) return `github:${a.databaseId}`;
  return "github:ghost";
}

const sha = (s: string | null | undefined) => (s && /^[0-9a-f]{40}$/.test(s) ? s : null);

/**
 * What a PR says it reverts. GitHub's revert button writes "Reverts owner/repo#12"; git
 * writes "This reverts commit <sha>". Read from the raw body; only numbers and SHAs are kept.
 */
export function parseReverts(body: string, fullName: string): { prs: number[]; shas: string[] } {
  const repo = fullName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prs = new Set<number>();
  for (const m of body.matchAll(new RegExp(`\\breverts\\s+(?:${repo})?#(\\d+)`, "gi"))) {
    prs.add(Number(m[1]));
  }
  const shas = new Set<string>();
  for (const m of body.matchAll(/\bthis reverts commit ([0-9a-f]{40})\b/gi))
    shas.add(m[1]!.toLowerCase());
  return { prs: [...prs].slice(0, 20), shas: [...shas].slice(0, 20) };
}

export function normalizePr(repo: { id: number; fullName: string }, pr: GqlPr): NormalizedPr {
  const isBot = pr.author?.__typename === "Bot";
  const reverts = parseReverts(pr.body ?? "", repo.fullName);
  const headlines = (pr.commitList?.nodes ?? []).map((n) => n.commit);
  const baseMerge = new RegExp(
    `^Merge (remote-tracking )?branch '(origin/)?${pr.baseRefName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`,
  );
  return {
    repoId: repo.id,
    repo: repo.fullName.toLowerCase(),
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "open",
    draft: pr.isDraft,
    author: {
      key: actorKey(pr.author),
      githubUserId: !isBot && pr.author?.databaseId ? pr.author.databaseId : null,
      isBot,
      login: pr.author?.login ?? null,
    },
    baseRef: pr.baseRefName,
    headRef: pr.headRefName,
    headSha: sha(pr.headRefOid),
    mergeCommitSha: sha(pr.mergeCommit?.oid),
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    commits: pr.commits.totalCount,
    labels: (pr.labels?.nodes ?? []).map((l) => l.name).slice(0, 50),
    files: (pr.files?.nodes ?? []).slice(0, 100),
    reviews: (pr.reviews?.nodes ?? [])
      .filter((r) => r.state !== "PENDING")
      .map((r) => ({ state: r.state, authorKey: actorKey(r.author), submittedAt: r.submittedAt })),
    closingIssues: (pr.closingIssuesReferences?.nodes ?? []).map((i) => i.number),
    ciState: pr.lastCommit?.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    firstCiState: pr.firstCommit?.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    baseSha: sha(pr.baseRefOid),
    revertsPrs: reverts.prs,
    revertsShas: reverts.shas,
    conflictCommits: headlines.filter((c) => /\bconflict/i.test(c.messageHeadline)).length,
    baseMergeCommits: headlines.filter(
      (c) => c.parents.totalCount > 1 && baseMerge.test(c.messageHeadline),
    ).length,
    openedAt: new Date(pr.createdAt),
    mergedAt: pr.mergedAt ? new Date(pr.mergedAt) : null,
    closedAt: pr.closedAt ? new Date(pr.closedAt) : null,
    updatedAt: new Date(pr.updatedAt),
  };
}
