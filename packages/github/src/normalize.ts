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

export function normalizePr(repo: { id: number; fullName: string }, pr: GqlPr): NormalizedPr {
  const isBot = pr.author?.__typename === "Bot";
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
    openedAt: new Date(pr.createdAt),
    mergedAt: pr.mergedAt ? new Date(pr.mergedAt) : null,
    closedAt: pr.closedAt ? new Date(pr.closedAt) : null,
    updatedAt: new Date(pr.updatedAt),
  };
}
