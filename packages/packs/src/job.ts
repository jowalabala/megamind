// The categorize.task job: load what's known about a task, decide its category, store it,
// and record the decision in the lake (task_categories).
import { randomUUID } from "node:crypto";
import {
  agentSessions,
  eq,
  externalRefs,
  githubPullRequests,
  tasks,
  type MasterMindDb,
} from "@mm/db";
import { categoryRecord, enqueueLakeRecords } from "@mm/lake";
import type { Llm } from "@mm/llm";
import {
  categorize,
  choosePack,
  type CategorizeInput,
  type CategoryDecision,
} from "./categorize.ts";
import { resolvePacks, type PackSource } from "./tenant.ts";

export interface CategorizeJob {
  tenantId: string;
  taskId: string;
}

export interface CategorizeDeps {
  db: MasterMindDb;
  packs: PackSource;
  /** Null disables the model step (local development without Bedrock). */
  llm: Llm | null;
}

export async function categorizeTask(
  deps: CategorizeDeps,
  job: CategorizeJob,
): Promise<CategoryDecision | null> {
  const loaded = await deps.db.withTenant(job.tenantId, async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, job.taskId));
    if (!task) return null;
    const [pr] = await tx
      .select()
      .from(githubPullRequests)
      .where(eq(githubPullRequests.taskId, task.id));
    const refs = await tx
      .select({ ref: externalRefs.ref })
      .from(externalRefs)
      .where(eq(externalRefs.taskId, task.id));
    const [session] = task.agentSessionId
      ? await tx
          .select({ context: agentSessions.contextRedacted })
          .from(agentSessions)
          .where(eq(agentSessions.id, task.agentSessionId))
      : [];
    return { task, pr, refs: refs.map((r) => r.ref), session };
  });
  if (!loaded) return null; // deleted (e.g. erased) since the job was queued
  const { task, pr, refs, session } = loaded;

  const { current } = await resolvePacks(deps.packs, job.tenantId);
  const pack = choosePack(current, {
    source: task.source,
    refSystems: [...new Set(refs.map((r) => r.split(":")[0]!))],
    codeSession: typeof session?.context?.repo === "string",
  });
  const input: CategorizeInput = {
    title: task.titleRedacted,
    summary: task.summaryRedacted,
    labels:
      pr?.labels ?? (Array.isArray(task.features.labels) ? (task.features.labels as string[]) : []),
    branch: pr?.headRefRedacted ?? (session?.context?.branch as string | undefined) ?? null,
    files: pr?.files.map((f) => f.path) ?? [],
    authorIsBot: pr?.authorIsBot ?? false,
    hint: task.categoryHint,
  };
  // The model call happens outside any transaction.
  const decision = await categorize(pack, input, { llm: deps.llm, tenantId: job.tenantId });

  await deps.db.withTenant(job.tenantId, async (tx) => {
    const updated = await tx
      .update(tasks)
      .set({
        pack: decision.pack,
        category: decision.category,
        categorySource: decision.method,
        categoryConfidence: decision.confidence,
        state: task.state === "logged" ? "categorized" : task.state,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id))
      .returning({ id: tasks.id });
    if (updated.length === 0) return;
    await enqueueLakeRecords(tx, job.tenantId, [
      categoryRecord({
        id: randomUUID(),
        tenantId: job.tenantId,
        memberId: task.memberId,
        actorKey: task.actorKey,
        agentId: task.agentIdentityId,
        source: task.source,
        taskId: task.id,
        pack: decision.pack,
        category: decision.category,
        method: decision.method,
        confidence: decision.confidence,
        categorizedAt: new Date(),
        ingestedAt: new Date(),
      }),
    ]);
  });
  return decision;
}
