// Outcome signals for merged PRs, written once they are mature.
//
// A PR's outcome is only known once its windows have passed: a revert within 30 days, a bug
// fix traced back to it within 60. So metrics are computed together, once, when the PR is
// 60 days past merge, its connection's history import is complete, and every bug fix merged
// in its window has been traced. Until then nothing is written, so nothing is ever revised.
import {
  and,
  eq,
  githubPrLinks,
  githubPullRequests,
  metricObservations,
  sql,
  type MasterMindDb,
} from "@mm/db";
import { idFromKey } from "@mm/ingest";
import { enqueueLakeRecords, metricRecord } from "@mm/lake";
import type { GithubApp } from "./client.ts";
import { RateLimitedError } from "./client.ts";
import { traceFix } from "./szz.ts";

export const WINDOWS = { revertDays: 30, defectDays: 60 };
/** Categories whose merged PRs are traced back as fixes. */
export const FIX_CATEGORIES = ["bugfix", "security"];

const DAY = 86_400_000;

export interface OutcomeDeps {
  db: MasterMindDb;
  app: GithubApp;
  now?: () => Date;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** Traces merged fix PRs to the PRs they repaired. Returns how many fixes were traced. */
export async function runSzzSweep(
  deps: OutcomeDeps,
  tenantId: string,
  limit = 20,
): Promise<number> {
  const due = await deps.db.withTenant(tenantId, (tx) =>
    tx.execute<{
      task_id: string;
      repo: string;
      number: number;
      base_sha: string | null;
      merged_at: Date;
      installation_id: string;
    }>(sql`
      SELECT p.task_id, p.repo, p.number, p.base_sha, p.merged_at, c.external_id AS installation_id
        FROM github_pull_requests p
        JOIN tasks t ON t.tenant_id = p.tenant_id AND t.id = p.task_id
        JOIN connections c ON c.tenant_id = p.tenant_id AND c.id = p.connection_id
       WHERE p.state = 'merged' AND p.szz_done_at IS NULL
         AND t.category IN (${sql.join(
           FIX_CATEGORIES.map((c) => sql`${c}`),
           sql`, `,
         )})
         AND c.status = 'active' AND c.backfill_status = 'done'
       ORDER BY p.merged_at
       LIMIT ${limit}`),
  );
  let traced = 0;
  for (const fix of due.rows) {
    let introducing = new Map<number, { files: number; lines: number }>();
    if (fix.base_sha) {
      try {
        ({ introducing } = await traceFix(deps.app.installation(fix.installation_id), {
          fullName: fix.repo,
          number: fix.number,
          baseSha: fix.base_sha,
          mergedAt: new Date(fix.merged_at),
        }));
      } catch (err) {
        if (err instanceof RateLimitedError) break; // next sweep
        throw err;
      }
    }
    await deps.db.withTenant(tenantId, async (tx) => {
      if (introducing.size) {
        const targets = await tx
          .select({ taskId: githubPullRequests.taskId, number: githubPullRequests.number })
          .from(githubPullRequests)
          .where(
            and(
              eq(githubPullRequests.repo, fix.repo),
              sql`${githubPullRequests.number} = ANY(${sql.raw(`ARRAY[${[...introducing.keys()].map(Number).join(",")}]::int[]`)})`,
            ),
          );
        for (const t of targets) {
          await tx
            .insert(githubPrLinks)
            .values({
              tenantId,
              fromTaskId: fix.task_id,
              toTaskId: t.taskId,
              kind: "fixes",
              evidence: introducing.get(t.number)!,
            })
            .onConflictDoNothing();
        }
      }
      await tx
        .update(githubPullRequests)
        .set({ szzDoneAt: new Date() })
        .where(eq(githubPullRequests.taskId, fix.task_id));
    });
    traced++;
  }
  if (traced) deps.log?.("github.szz", { tenantId, traced });
  return traced;
}

type Candidate = {
  task_id: string;
  repo: string;
  number: number;
  merged_at: Date;
  opened_at: Date;
  merge_commit_sha: string | null;
  first_ci_state: string | null;
  conflict_commits: number;
  reviews: { state: string; author_key: string }[];
  author_key: string;
  title: string;
  member_id: string | null;
  actor_key: string | null;
};

/** Writes the outcome metrics of mature merged PRs. Returns how many PRs were finalized. */
export async function finalizeMetrics(
  deps: Pick<OutcomeDeps, "db" | "now" | "log">,
  tenantId: string,
  limit = 200,
): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const matureBefore = new Date(now.getTime() - WINDOWS.defectDays * DAY);

  return deps.db.withTenant(tenantId, async (tx) => {
    const due = await tx.execute<Candidate>(sql`
      SELECT p.task_id, p.repo, p.number, p.merged_at, p.opened_at, p.merge_commit_sha,
             p.first_ci_state, p.conflict_commits, p.reviews, p.author_key,
             t.title_redacted AS title, t.member_id, t.actor_key
        FROM github_pull_requests p
        JOIN tasks t ON t.tenant_id = p.tenant_id AND t.id = p.task_id
        JOIN connections c ON c.tenant_id = p.tenant_id AND c.id = p.connection_id
       WHERE p.state = 'merged' AND p.metrics_final_at IS NULL
         AND p.merged_at <= ${matureBefore.toISOString()}
         AND c.backfill_status = 'done'
         -- Every later PR in the defect window is categorized, and every fix among them traced.
         AND NOT EXISTS (
           SELECT 1 FROM github_pull_requests f
             JOIN tasks ft ON ft.tenant_id = f.tenant_id AND ft.id = f.task_id
            WHERE f.repo = p.repo AND f.state = 'merged'
              AND f.merged_at > p.merged_at
              AND f.merged_at <= p.merged_at + make_interval(days => ${WINDOWS.defectDays})
              AND (ft.category IS NULL
                   OR (ft.category IN (${sql.join(
                     FIX_CATEGORIES.map((c) => sql`${c}`),
                     sql`, `,
                   )})
                       AND f.szz_done_at IS NULL)))
       ORDER BY p.merged_at
       LIMIT ${limit}`);

    for (const p of due.rows) {
      const merged = new Date(p.merged_at);
      // Reverted: a merged PR within 30 days that names this one.
      const reverters = await tx.execute<{ task_id: string }>(sql`
        SELECT r.task_id FROM github_pull_requests r
          JOIN tasks rt ON rt.tenant_id = r.tenant_id AND rt.id = r.task_id
         WHERE r.repo = ${p.repo} AND r.state = 'merged' AND r.task_id <> ${p.task_id}
           AND r.merged_at > ${merged.toISOString()}
           AND r.merged_at <= ${new Date(merged.getTime() + WINDOWS.revertDays * DAY).toISOString()}
           AND (${p.number} = ANY(r.reverts_prs)
                OR (${p.merge_commit_sha}::text IS NOT NULL AND ${p.merge_commit_sha}::text = ANY(r.reverts_shas))
                OR rt.title_redacted = ${`Revert "${p.title}"`})`);
      for (const r of reverters.rows) {
        await tx
          .insert(githubPrLinks)
          .values({ tenantId, fromTaskId: r.task_id, toTaskId: p.task_id, kind: "reverts" })
          .onConflictDoNothing();
      }
      // Escaped defect: a fix merged within 60 days was traced back to this PR.
      const fixes = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM github_pr_links l
          JOIN github_pull_requests f ON f.tenant_id = l.tenant_id AND f.task_id = l.from_task_id
         WHERE l.to_task_id = ${p.task_id} AND l.kind = 'fixes'
           AND f.merged_at <= ${new Date(merged.getTime() + WINDOWS.defectDays * DAY).toISOString()}`);

      const ci = p.first_ci_state;
      const metrics: Record<string, number | null> = {
        "ci.first_pass": ci === "SUCCESS" ? 1 : ci === "FAILURE" || ci === "ERROR" ? 0 : null,
        "pr.reverted": reverters.rows.length > 0 ? 1 : 0,
        "pr.escaped_defect": fixes.rows[0]!.n > 0 ? 1 : 0,
        "pr.review_rounds": p.reviews.filter(
          (r) => r.state === "CHANGES_REQUESTED" && r.author_key !== p.author_key,
        ).length,
        "pr.hours_to_merge":
          Math.round(((merged.getTime() - new Date(p.opened_at).getTime()) / 3_600_000) * 100) /
          100,
        "pr.merge_conflict": p.conflict_commits > 0 ? 1 : 0,
      };
      // Observed at maturity, so a replay writes identical rows.
      const observedAt = new Date(merged.getTime() + WINDOWS.defectDays * DAY);
      const records = [];
      for (const [key, value] of Object.entries(metrics)) {
        if (value === null) continue;
        const id = idFromKey([p.task_id, "metric", key]);
        await tx
          .insert(metricObservations)
          .values({
            id,
            tenantId,
            taskId: p.task_id,
            metricKey: key,
            value,
            n: 1,
            source: "github",
            observedAt,
          })
          .onConflictDoUpdate({ target: metricObservations.id, set: { value, observedAt } });
        records.push(
          metricRecord({
            id,
            tenantId,
            memberId: p.member_id,
            actorKey: p.actor_key,
            agentId: null,
            source: "github",
            taskId: p.task_id,
            metric: key,
            value,
            n: 1,
            note: null,
            observedAt,
            ingestedAt: now,
          }),
        );
      }
      await enqueueLakeRecords(tx, tenantId, records);
      await tx
        .update(githubPullRequests)
        .set({ metricsFinalAt: now })
        .where(eq(githubPullRequests.taskId, p.task_id));
    }
    if (due.rows.length) deps.log?.("github.metrics_finalized", { tenantId, prs: due.rows.length });
    return due.rows.length;
  });
}
