// History backfill: every repository the installation can see, newest PRs first, 25 per
// job, back to `since`. Each page is its own job, so a crash or rate limit loses one page
// at most, and progress is visible on the connection.
import { connectionRepo, type Connection } from "@mm/db";
import { idFromKey } from "@mm/ingest";
import type { GithubApp } from "./client.ts";
import { RateLimitedError } from "./client.ts";
import { normalizePr } from "./normalize.ts";
import { PR_PAGE_QUERY, type PrPageResult } from "./queries.ts";
import { upsertPullRequest, type SyncDeps } from "./sync.ts";

export interface BackfillRepoJob {
  tenantId: string;
  connectionId: string;
  installationId: string;
  repoId: number;
  /** owner/name as GitHub returns it. */
  fullName: string;
  cursor: string | null;
  /** ISO date: PRs created before this are not fetched. */
  since: string;
}

export interface GithubDeps extends SyncDeps {
  app: GithubApp;
  enqueue: (
    name: "github.backfill_repo" | "github.sync_pr" | "categorize.task",
    data: object,
    options?: { id?: string; startAfter?: Date },
  ) => Promise<void>;
  /** How far back a first backfill goes. Default 12 months. */
  backfillMonths?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

interface InstallationRepo {
  id: number;
  full_name: string;
  archived: boolean;
}

/** Kicks off a backfill: lists the installation's repositories and queues their first pages. */
export async function startBackfill(deps: GithubDeps, tenantId: string, conn: Connection) {
  const gh = deps.app.installation(conn.externalId);
  const repos: InstallationRepo[] = [];
  for (let page = 1; page <= 50; page++) {
    const res = await gh.rest<{ repositories: InstallationRepo[] }>(
      "GET",
      `/installation/repositories?per_page=100&page=${page}`,
    );
    repos.push(...res.repositories);
    if (res.repositories.length < 100) break;
  }
  const active = repos.filter((r) => !r.archived);
  const since = new Date();
  since.setMonth(since.getMonth() - (deps.backfillMonths ?? 12));

  await deps.db.withTenant(tenantId, async (tx) => {
    for (const r of active) {
      await connectionRepo.updateBackfill(tx, conn.id, {
        repo: { id: String(r.id), name: r.full_name.toLowerCase(), done: false },
      });
    }
    await connectionRepo.updateBackfill(tx, conn.id, {
      backfillStatus: active.length ? "running" : "done",
      backfillError: null,
    });
  });
  for (const r of active) {
    await queueRepoPages(deps, {
      tenantId,
      connectionId: conn.id,
      installationId: conn.externalId,
      repoId: r.id,
      fullName: r.full_name,
      cursor: null,
      since: since.toISOString(),
    });
  }
  deps.log?.("github.backfill_started", { tenantId, connectionId: conn.id, repos: active.length });
  return active.length;
}

export async function queueRepoPages(
  deps: Pick<GithubDeps, "enqueue">,
  job: BackfillRepoJob,
  startAfter?: Date,
) {
  await deps.enqueue("github.backfill_repo", job, {
    // One job per page: a duplicate send is a no-op.
    id: idFromKey([job.connectionId, String(job.repoId), job.cursor ?? "start", job.since]),
    startAfter,
  });
}

/** One page of one repository. Returns how many PRs were stored. */
export async function backfillRepoPage(deps: GithubDeps, job: BackfillRepoJob): Promise<number> {
  const [owner, name] = job.fullName.split("/");
  let res: PrPageResult;
  try {
    res = await deps.app
      .installation(job.installationId)
      .graphql<PrPageResult>(PR_PAGE_QUERY, { owner, name, cursor: job.cursor });
  } catch (err) {
    if (err instanceof RateLimitedError) {
      // Try the same page again once the limit resets.
      await deps.enqueue("github.backfill_repo", job, {
        id: idFromKey([
          job.connectionId,
          String(job.repoId),
          job.cursor ?? "start",
          "retry",
          err.retryAt.toISOString(),
        ]),
        startAfter: err.retryAt,
      });
      return 0;
    }
    throw err;
  }

  const page = res.repository?.pullRequests;
  const since = new Date(job.since);
  let stored = 0;
  let reachedSince = false;
  for (const node of page?.nodes ?? []) {
    if (new Date(node.createdAt) < since) {
      reachedSince = true;
      break;
    }
    const pr = normalizePr({ id: job.repoId, fullName: job.fullName }, node);
    const out = await upsertPullRequest(deps, job, pr);
    if (out.status === "stored") {
      stored++;
      if (out.created || out.closedNow) {
        await deps.enqueue(
          "categorize.task",
          { tenantId: job.tenantId, taskId: out.taskId },
          { id: idFromKey([out.taskId, "categorize", pr.state]) },
        );
      }
    }
  }

  const more = !!page?.pageInfo.hasNextPage && !reachedSince && !!page.pageInfo.endCursor;
  const conn = await deps.db.withTenant(job.tenantId, (tx) =>
    connectionRepo.updateBackfill(tx, job.connectionId, {
      repo: { id: String(job.repoId), addPrs: stored, done: !more },
    }),
  );
  if (more) {
    // Leave headroom for webhooks: when the budget is low, wait for the reset.
    const low = res.rateLimit && res.rateLimit.remaining < 200;
    await queueRepoPages(
      deps,
      { ...job, cursor: page!.pageInfo.endCursor },
      low ? new Date(res.rateLimit!.resetAt) : undefined,
    );
  } else if (Object.values(conn.backfillState).every((r) => r.done)) {
    await deps.db.withTenant(job.tenantId, (tx) =>
      connectionRepo.updateBackfill(tx, job.connectionId, { backfillStatus: "done" }),
    );
    deps.log?.("github.backfill_done", { tenantId: job.tenantId, connectionId: job.connectionId });
  }
  return stored;
}
