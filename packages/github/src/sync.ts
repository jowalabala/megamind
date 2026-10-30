// One PR -> one task (source "github") plus its facts row. Idempotent: the task id derives
// from the repository id and PR number, and re-syncs update in place.
import {
  and,
  eq,
  externalRefs,
  githubPullRequests,
  members,
  tasks,
  type MasterMindDb,
} from "@mm/db";
import { idFromKey, type RedactorFor } from "@mm/ingest";
import { enqueueLakeRecords, taskRecord } from "@mm/lake";
import { prFeatures } from "./features.ts";
import type { NormalizedPr } from "./normalize.ts";

export interface SyncDeps {
  db: MasterMindDb;
  redactorFor: RedactorFor;
}

export interface SyncContext {
  tenantId: string;
  connectionId: string;
}

export type SyncOutcome =
  | { status: "skipped_opt_out" | "skipped_stale" }
  | { status: "stored"; taskId: string; created: boolean; closedNow: boolean };

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

export function prTaskId(tenantId: string, repoId: number, number: number): string {
  return idFromKey([tenantId, "github", "pr", String(repoId), String(number)]);
}

export async function upsertPullRequest(
  deps: SyncDeps,
  ctx: SyncContext,
  pr: NormalizedPr,
): Promise<SyncOutcome> {
  const taskId = prTaskId(ctx.tenantId, pr.repoId, pr.number);
  const features = prFeatures(pr);

  // Redaction can call an external service, so it runs before the transaction.
  const r = await deps.redactorFor(ctx.tenantId);
  const title = await r.redact(clip(pr.title, 1_000));
  const body = await r.redact(clip(pr.body, 20_000));
  const branch = await r.redact(clip(pr.headRef, 300));
  const terminal = pr.state !== "open";
  const completedAt = pr.mergedAt ?? pr.closedAt;

  return deps.db.withTenant(ctx.tenantId, async (tx) => {
    // A linked author who opted out of capture: their PRs are not stored.
    const [member] = pr.author.githubUserId
      ? await tx
          .select({ id: members.id, optOut: members.captureOptOut })
          .from(members)
          .where(eq(members.githubUserId, pr.author.githubUserId))
      : [];
    if (member?.optOut) return { status: "skipped_opt_out" as const };

    const [existing] = await tx
      .select({
        ghUpdatedAt: githubPullRequests.ghUpdatedAt,
        lakeEmittedAt: githubPullRequests.lakeEmittedAt,
      })
      .from(githubPullRequests)
      .where(eq(githubPullRequests.taskId, taskId));
    // Syncs can arrive out of order; never let an older snapshot overwrite a newer one.
    if (existing && existing.ghUpdatedAt > pr.updatedAt)
      return { status: "skipped_stale" as const };

    const values = {
      titleRedacted: title.text || "(untitled pull request)",
      summaryRedacted: clip(body.text, 40_000),
      features,
      redactionCounts: { ...title.counts, ...body.counts },
      startedAt: pr.openedAt,
      completedAt,
      updatedAt: new Date(),
    };
    await tx
      .insert(tasks)
      .values({
        id: taskId,
        tenantId: ctx.tenantId,
        memberId: member?.id ?? null,
        actorKey: pr.author.key,
        connectionId: ctx.connectionId,
        source: "github",
        ...values,
      })
      .onConflictDoUpdate({ target: tasks.id, set: values });

    const prRow = {
      connectionId: ctx.connectionId,
      repoId: pr.repoId,
      repo: pr.repo,
      number: pr.number,
      authorKey: pr.author.key,
      authorIsBot: pr.author.isBot,
      state: pr.state,
      draft: pr.draft,
      baseRef: clip(pr.baseRef, 300),
      headRefRedacted: branch.text,
      headSha: pr.headSha,
      mergeCommitSha: pr.mergeCommitSha,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      commits: pr.commits,
      labels: pr.labels,
      files: pr.files,
      reviews: pr.reviews.map((x) => ({
        state: x.state,
        author_key: x.authorKey,
        submitted_at: x.submittedAt,
      })),
      closingIssues: pr.closingIssues,
      ciState: pr.ciState,
      firstCiState: pr.firstCiState,
      baseSha: pr.baseSha,
      revertsPrs: pr.revertsPrs,
      revertsShas: pr.revertsShas,
      conflictCommits: pr.conflictCommits,
      baseMergeCommits: pr.baseMergeCommits,
      openedAt: pr.openedAt,
      mergedAt: pr.mergedAt,
      closedAt: pr.closedAt,
      ghUpdatedAt: pr.updatedAt,
      syncedAt: new Date(),
    };
    await tx
      .insert(githubPullRequests)
      .values({ tenantId: ctx.tenantId, taskId, ...prRow })
      .onConflictDoUpdate({
        target: [githubPullRequests.tenantId, githubPullRequests.taskId],
        set: prRow,
      });

    const refs = [
      `github:pr:${pr.repo}#${pr.number}`,
      ...pr.closingIssues.map((n) => `github:issue:${pr.repo}#${n}`),
    ];
    await tx
      .insert(externalRefs)
      .values(refs.map((ref) => ({ tenantId: ctx.tenantId, taskId, ref })))
      .onConflictDoNothing();

    // The lake gets a PR's task row once, when it is first closed or merged.
    let closedNow = false;
    if (terminal && !existing?.lakeEmittedAt) {
      closedNow = true;
      await enqueueLakeRecords(tx, ctx.tenantId, [
        taskRecord({
          id: taskId,
          tenantId: ctx.tenantId,
          memberId: member?.id ?? null,
          actorKey: pr.author.key,
          agentId: null,
          source: "github",
          sessionId: null,
          private: false,
          title: values.titleRedacted,
          summary: values.summaryRedacted,
          categoryHint: null,
          externalRefs: refs,
          features: { ...features, repo: pr.repo, state: pr.state, labels: pr.labels },
          startedAt: pr.openedAt,
          completedAt,
          createdAt: pr.openedAt,
          ingestedAt: new Date(),
        }),
      ]);
      await tx
        .update(githubPullRequests)
        .set({ lakeEmittedAt: new Date() })
        .where(
          and(eq(githubPullRequests.tenantId, ctx.tenantId), eq(githubPullRequests.taskId, taskId)),
        );
    }
    return { status: "stored" as const, taskId, created: !existing, closedNow };
  });
}
