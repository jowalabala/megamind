// Worker wiring for the GitHub connector.
import { connectionRepo, type MasterMindDb } from "@mm/db";
import type { QueueClient } from "@mm/db/queue";
import { idFromKey } from "@mm/ingest";
import {
  backfillRepoPage,
  queueRepoPages,
  startBackfill,
  type BackfillRepoJob,
  type GithubDeps,
} from "./backfill.ts";
import { GithubError, RateLimitedError } from "./client.ts";
import { normalizePr } from "./normalize.ts";
import { PR_QUERY, type PrResult } from "./queries.ts";
import { upsertPullRequest } from "./sync.ts";
import type { SyncPrJob } from "./webhooks.ts";

export async function syncPr(deps: GithubDeps, job: SyncPrJob): Promise<string> {
  const [owner, name] = job.fullName.split("/");
  let res: PrResult;
  try {
    res = await deps.app
      .installation(job.installationId)
      .graphql<PrResult>(PR_QUERY, { owner, name, number: job.number });
  } catch (err) {
    if (err instanceof RateLimitedError) {
      await deps.enqueue("github.sync_pr", job, {
        id: idFromKey([
          job.connectionId,
          String(job.repoId),
          String(job.number),
          err.retryAt.toISOString(),
        ]),
        startAfter: err.retryAt,
      });
      return "rate_limited";
    }
    // Gone or no longer visible to the installation: nothing to sync.
    if (err instanceof GithubError && err.status === 404) return "not_found";
    throw err;
  }
  const node = res.repository?.pullRequest;
  if (!node) return "not_found";
  const pr = normalizePr({ id: job.repoId, fullName: job.fullName }, node);
  const out = await upsertPullRequest(deps, job, pr);
  if (out.status === "stored" && (out.created || out.closedNow)) {
    await deps.enqueue(
      "categorize.task",
      { tenantId: job.tenantId, taskId: out.taskId },
      { id: idFromKey([out.taskId, "categorize", pr.state]) },
    );
  }
  return out.status;
}

/** Starts backfills for connections that are waiting for one (new installs). */
export async function startPendingBackfills(deps: GithubDeps & { db: MasterMindDb }) {
  let started = 0;
  for (const t of await deps.db.system.listTenantsForJobs()) {
    const pending = await deps.db.withTenant(t.tenantId, (tx) =>
      connectionRepo.pendingBackfills(tx),
    );
    for (const conn of pending) {
      try {
        await startBackfill(deps, t.tenantId, conn);
        started++;
      } catch (err) {
        await deps.db.withTenant(t.tenantId, (tx) =>
          connectionRepo.updateBackfill(tx, conn.id, {
            backfillStatus: "failed",
            backfillError: (err as Error).message.slice(0, 2000),
          }),
        );
        deps.log?.("github.backfill_failed", { tenantId: t.tenantId, connectionId: conn.id });
      }
    }
  }
  return started;
}

/** Backfills repositories added to an existing installation. */
export async function backfillAddedRepos(
  deps: Pick<GithubDeps, "db" | "enqueue" | "backfillMonths">,
  target: { tenantId: string; connectionId: string; installationId: string },
  repos: { id: number; fullName: string }[],
) {
  const since = new Date();
  since.setMonth(since.getMonth() - (deps.backfillMonths ?? 12));
  await deps.db.withTenant(target.tenantId, async (tx) => {
    for (const r of repos) {
      await connectionRepo.updateBackfill(tx, target.connectionId, {
        repo: { id: String(r.id), name: r.fullName.toLowerCase(), done: false },
      });
    }
    await connectionRepo.updateBackfill(tx, target.connectionId, { backfillStatus: "running" });
  });
  for (const r of repos) {
    await queueRepoPages(deps, {
      ...target,
      repoId: r.id,
      fullName: r.fullName,
      cursor: null,
      since: since.toISOString(),
    });
  }
}

export async function startGithubWorkers(queue: Pick<QueueClient, "work">, deps: GithubDeps) {
  await queue.work<SyncPrJob>("github.sync_pr", async (job) => {
    const status = await syncPr(deps, job.data);
    deps.log?.("github.sync_pr", { tenantId: job.data.tenantId, status });
  });
  await queue.work<BackfillRepoJob>("github.backfill_repo", async (job) => {
    const stored = await backfillRepoPage(deps, job.data);
    deps.log?.("github.backfill_page", {
      tenantId: job.data.tenantId,
      repoId: job.data.repoId,
      stored,
    });
  });
}
