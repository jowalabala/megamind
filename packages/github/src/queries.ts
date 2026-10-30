// GraphQL: one query returns everything we keep about a PR (metadata only, no diffs).
export const PR_FIELDS = `
fragment PrFields on PullRequest {
  databaseId number title body state isDraft createdAt updatedAt mergedAt closedAt
  author { __typename login ... on User { databaseId } ... on Bot { databaseId } }
  additions deletions changedFiles baseRefName headRefName headRefOid
  mergeCommit { oid }
  labels(first: 20) { nodes { name } }
  commits { totalCount }
  lastCommit: commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviews(first: 50) {
    nodes { state submittedAt author { __typename login ... on User { databaseId } ... on Bot { databaseId } } }
  }
  files(first: 100) { nodes { path additions deletions } }
  closingIssuesReferences(first: 10) { nodes { number } }
}`;

export const PR_PAGE_QUERY = `
query PrPage($owner: String!, $name: String!, $cursor: String) {
  rateLimit { remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequests(first: 25, after: $cursor, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ...PrFields }
    }
  }
}
${PR_FIELDS}`;

export const PR_QUERY = `
query OnePr($owner: String!, $name: String!, $number: Int!) {
  rateLimit { remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { ...PrFields }
  }
}
${PR_FIELDS}`;

export interface GqlActor {
  __typename: string;
  login: string;
  databaseId?: number | null;
}

export interface GqlPr {
  databaseId: number;
  number: number;
  title: string;
  body: string | null;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  author: GqlActor | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  baseRefName: string;
  headRefName: string;
  headRefOid: string | null;
  mergeCommit: { oid: string } | null;
  labels: { nodes: { name: string }[] } | null;
  commits: { totalCount: number };
  lastCommit: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] } | null;
  reviews: {
    nodes: { state: string; submittedAt: string | null; author: GqlActor | null }[];
  } | null;
  files: { nodes: { path: string; additions: number; deletions: number }[] } | null;
  closingIssuesReferences: { nodes: { number: number }[] } | null;
}

export interface RateLimit {
  remaining: number;
  resetAt: string;
}

export interface PrPageResult {
  rateLimit: RateLimit | null;
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: GqlPr[];
    };
  } | null;
}

export interface PrResult {
  rateLimit: RateLimit | null;
  repository: { pullRequest: GqlPr | null } | null;
}
