// Worker side of ingest: bronze -> opt-out check -> redact -> normalize -> Postgres.
// Every handler is idempotent, so pg-boss retries are safe.
import {
  actionEvents,
  agentSessions,
  and,
  artifacts,
  eq,
  externalRefs,
  inArray,
  intents,
  members,
  metricObservations,
  tasks,
  type MasterMindDb,
  type TenantTx,
} from "@mm/db";
import type { QueueClient } from "@mm/db/queue";
import { detectOverlaps } from "@mm/awareness";
import { actionRecord, enqueueLakeRecords, metricRecord, taskRecord } from "@mm/lake";
import { mergeCounts, type Redactor } from "@mm/privacy";
import { idFromKey, type BronzeEnvelope, type IngestJob } from "./accept.ts";
import type { BronzeStore } from "./bronze.ts";
import type { RedactorFor } from "./redaction.ts";
import { recordSkillUses } from "./skill-usage.ts";
import {
  actionBatchInput,
  announceIntentInput,
  logTaskInput,
  reportOutcomeInput,
  type SessionInput,
} from "./schemas.ts";

export interface ProcessDeps {
  db: MasterMindDb;
  bronze: BronzeStore;
  redactorFor: RedactorFor;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export type ProcessOutcome = "stored" | "duplicate" | "dropped_opt_out" | "dropped_expired";

/** Thrown when a job should be retried later (e.g. its task hasn't been processed yet). */
export class RetryLaterError extends Error {
  override name = "RetryLaterError";
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

async function loadEnvelope(deps: ProcessDeps, job: IngestJob) {
  const raw = (await deps.bronze.get(job.bronzeKey)) as BronzeEnvelope<unknown> | null;
  if (!raw) return null;
  // The queue only carries pointers, but check the two agree before trusting either.
  if (
    raw.tenantId !== job.tenantId ||
    raw.memberId !== job.memberId ||
    raw.agentId !== job.agentId
  ) {
    throw new Error(`Bronze envelope does not match job ${job.id}`);
  }
  return raw;
}

async function memberOptedOut(tx: TenantTx, memberId: string): Promise<boolean> {
  const [m] = await tx
    .select({ optOut: members.captureOptOut })
    .from(members)
    .where(eq(members.id, memberId));
  // A deleted member is treated as opted out.
  return !m || m.optOut;
}

async function redactSession(redactor: Redactor, s: SessionInput) {
  const { value, counts } = await redactor.redactValue({
    repo: s.repo,
    branch: s.branch,
    tool: s.tool,
  });
  return { context: JSON.parse(JSON.stringify(value)) as Record<string, unknown>, counts };
}

async function upsertSession(
  tx: TenantTx,
  job: IngestJob,
  s: SessionInput,
  context: Record<string, unknown>,
): Promise<{ id: string; private: boolean }> {
  const [row] = await tx
    .insert(agentSessions)
    .values({
      tenantId: job.tenantId,
      agentIdentityId: job.agentId,
      memberId: job.memberId,
      clientSessionId: s.id,
      contextRedacted: context,
      private: s.private ?? false,
    })
    .onConflictDoUpdate({
      target: [
        agentSessions.tenantId,
        agentSessions.agentIdentityId,
        agentSessions.clientSessionId,
      ],
      set: { lastHeartbeatAt: new Date(), contextRedacted: context },
    })
    .returning({ id: agentSessions.id, private: agentSessions.private });
  // Once a session is private it stays private.
  if (s.private && !row!.private) {
    await tx.update(agentSessions).set({ private: true }).where(eq(agentSessions.id, row!.id));
  }
  return { id: row!.id, private: row!.private || !!s.private };
}

async function dropRaw(deps: ProcessDeps, job: IngestJob, outcome: ProcessOutcome) {
  // An opted-out member's raw payload is deleted now rather than left for the 30-day expiry.
  await deps.bronze.delete(job.bronzeKey);
  deps.log?.("ingest.dropped", { id: job.id, tenantId: job.tenantId, reason: outcome });
  return outcome;
}

export async function processTask(deps: ProcessDeps, job: IngestJob): Promise<ProcessOutcome> {
  const env = await loadEnvelope(deps, job);
  if (!env) return "dropped_expired";
  const input = logTaskInput.parse(env.payload);
  if (await deps.db.withTenant(job.tenantId, (tx) => memberOptedOut(tx, job.memberId))) {
    return dropRaw(deps, job, "dropped_opt_out");
  }

  // Redaction can call an external service, so it runs before the transaction opens.
  const r = await deps.redactorFor(job.tenantId);
  const title = await r.redact(input.title);
  const summary = await r.redact(input.summary);
  const hint = input.category_hint ? await r.redact(input.category_hint) : null;
  const arts = await Promise.all(
    input.artifacts.map(async (a) => ({
      kind: a.kind,
      content: a.content !== undefined ? await r.redact(a.content) : null,
      uri: a.uri !== undefined ? await r.redact(a.uri) : null,
    })),
  );
  const refs = await Promise.all(input.external_refs.map((ref) => r.redact(ref)));
  const session = input.session ? await redactSession(r, input.session) : null;
  const counts = mergeCounts(
    title.counts,
    summary.counts,
    hint?.counts ?? {},
    ...arts.flatMap((a) => [a.content?.counts ?? {}, a.uri?.counts ?? {}]),
    ...refs.map((x) => x.counts),
    session?.counts ?? {},
  );

  return deps.db.withTenant(job.tenantId, async (tx) => {
    // Checked again inside the write transaction, in case the member opted out meanwhile.
    if (await memberOptedOut(tx, job.memberId)) return "dropped_opt_out" as const;
    const session_ = input.session
      ? await upsertSession(tx, job, input.session, session!.context)
      : null;
    const sessionId = session_?.id ?? null;
    const features = {
      artifact_kinds: [...new Set(input.artifacts.map((a) => a.kind))].sort(),
      ref_systems: [...new Set(input.external_refs.map((x) => x.split(":")[0]))].sort(),
      summary_chars: input.summary.length,
    };
    const inserted = await tx
      .insert(tasks)
      .values({
        id: job.id,
        tenantId: job.tenantId,
        memberId: job.memberId,
        agentIdentityId: job.agentId,
        agentSessionId: sessionId,
        source: job.source ?? "mcp",
        idempotencyKey: input.idempotency_key ?? null,
        titleRedacted: clip(title.text, 1_000),
        summaryRedacted: clip(summary.text, 40_000),
        categoryHint: hint ? clip(hint.text, 100) : null,
        features,
        redactionCounts: counts,
        startedAt: input.started_at ? new Date(input.started_at) : null,
        completedAt: input.completed_at ? new Date(input.completed_at) : null,
      })
      .onConflictDoNothing()
      .returning({ id: tasks.id, createdAt: tasks.createdAt });
    if (inserted.length === 0) return "duplicate" as const;

    if (arts.length > 0) {
      await tx.insert(artifacts).values(
        arts.map((a) => ({
          tenantId: job.tenantId,
          taskId: job.id,
          kind: a.kind,
          contentRedacted: a.content ? clip(a.content.text, 200_000) : null,
          uriRedacted: a.uri ? clip(a.uri.text, 2_000) : null,
        })),
      );
    }
    // A ref that held personal data no longer matches system:type:id after redaction; skip it.
    const cleanRefs = [...new Set(refs.map((x) => x.text))].filter((x) =>
      /^[a-z][a-z0-9_]{0,30}:[a-z][a-z0-9_]{0,30}:\S{1,400}$/.test(x),
    );
    if (cleanRefs.length > 0) {
      await tx
        .insert(externalRefs)
        .values(cleanRefs.map((ref) => ({ tenantId: job.tenantId, taskId: job.id, ref })))
        .onConflictDoNothing();
    }
    await enqueueLakeRecords(tx, job.tenantId, [
      taskRecord({
        id: job.id,
        tenantId: job.tenantId,
        memberId: job.memberId,
        agentId: job.agentId,
        source: job.source ?? "mcp",
        sessionId,
        private: session_?.private ?? false,
        title: clip(title.text, 1_000),
        summary: clip(summary.text, 40_000),
        categoryHint: hint ? clip(hint.text, 100) : null,
        externalRefs: cleanRefs,
        features,
        startedAt: input.started_at ? new Date(input.started_at) : null,
        completedAt: input.completed_at ? new Date(input.completed_at) : null,
        createdAt: inserted[0]!.createdAt,
        ingestedAt: new Date(),
      }),
    ]);
    if (input.skills_used.length > 0) {
      await recordSkillUses(
        tx,
        job.tenantId,
        {
          memberId: job.memberId,
          agentId: job.agentId,
          sessionId,
          taskId: job.id,
          source: job.source === "bridge" ? "bridge" : "mcp",
          usedAt: input.completed_at ? new Date(input.completed_at) : inserted[0]!.createdAt,
          key: job.id,
        },
        input.skills_used.map((u) => ({
          skillId: u.skill_id,
          version: u.version,
          adherence: u.adherence,
        })),
      );
    }
    return "stored" as const;
  });
}

export async function processOutcome(deps: ProcessDeps, job: IngestJob): Promise<ProcessOutcome> {
  const env = await loadEnvelope(deps, job);
  if (!env) return "dropped_expired";
  const input = reportOutcomeInput.parse(env.payload);
  if (await deps.db.withTenant(job.tenantId, (tx) => memberOptedOut(tx, job.memberId))) {
    return dropRaw(deps, job, "dropped_opt_out");
  }
  const r = await deps.redactorFor(job.tenantId);
  const note = input.note !== undefined ? await r.redact(input.note) : null;

  return deps.db.withTenant(job.tenantId, async (tx) => {
    if (await memberOptedOut(tx, job.memberId)) return "dropped_opt_out" as const;
    // Agents can report outcomes only for their own member's tasks.
    const [task] = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, input.task_id), eq(tasks.memberId, job.memberId)));
    if (!task) {
      // Usually the task's own job hasn't run yet. pg-boss retries with backoff.
      throw new RetryLaterError(`Task ${input.task_id} not found for this member (yet).`);
    }
    const inserted = await tx
      .insert(metricObservations)
      .values({
        id: job.id,
        tenantId: job.tenantId,
        taskId: input.task_id,
        metricKey: input.metric,
        value: input.value,
        n: input.n,
        source: job.source ?? "mcp",
        agentIdentityId: job.agentId,
        noteRedacted: note ? clip(note.text, 4_000) : null,
        observedAt: input.observed_at ? new Date(input.observed_at) : new Date(env.receivedAt),
      })
      .onConflictDoNothing()
      .returning({ id: metricObservations.id, observedAt: metricObservations.observedAt });
    if (inserted.length === 0) return "duplicate" as const;
    await enqueueLakeRecords(tx, job.tenantId, [
      metricRecord({
        id: job.id,
        tenantId: job.tenantId,
        memberId: job.memberId,
        agentId: job.agentId,
        source: job.source ?? "mcp",
        taskId: input.task_id,
        metric: input.metric,
        value: input.value,
        n: input.n,
        note: note ? clip(note.text, 4_000) : null,
        observedAt: inserted[0]!.observedAt,
        ingestedAt: new Date(),
      }),
    ]);
    return "stored" as const;
  });
}

export async function processActions(deps: ProcessDeps, job: IngestJob): Promise<ProcessOutcome> {
  const env = await loadEnvelope(deps, job);
  if (!env) return "dropped_expired";
  const input = actionBatchInput.parse(env.payload);
  if (await deps.db.withTenant(job.tenantId, (tx) => memberOptedOut(tx, job.memberId))) {
    return dropRaw(deps, job, "dropped_opt_out");
  }
  const r = await deps.redactorFor(job.tenantId);
  const session = await redactSession(r, input.session);
  const events = await Promise.all(
    input.events.map(async (e) => ({
      ...e,
      summary: (await r.redact(e.summary)).text,
      resources: await Promise.all(e.resources.map(async (res) => (await r.redact(res)).text)),
    })),
  );

  return deps.db.withTenant(job.tenantId, async (tx) => {
    if (await memberOptedOut(tx, job.memberId)) return "dropped_opt_out" as const;
    const sess = await upsertSession(tx, job, input.session, session.context);
    const sessionId = sess.id;
    // Links to tasks that don't exist (or aren't this member's) are dropped, not failed.
    const wanted = [...new Set(events.flatMap((e) => (e.task_id ? [e.task_id] : [])))];
    const known = wanted.length
      ? new Set(
          (
            await tx
              .select({ id: tasks.id })
              .from(tasks)
              .where(and(inArray(tasks.id, wanted), eq(tasks.memberId, job.memberId)))
          ).map((t) => t.id),
        )
      : new Set<string>();
    const inserted = await tx
      .insert(actionEvents)
      .values(
        events.map((e) => ({
          tenantId: job.tenantId,
          id: e.id,
          sessionId,
          memberId: job.memberId,
          taskId: e.task_id && known.has(e.task_id) ? e.task_id : null,
          kind: e.kind,
          summaryRedacted: clip(e.summary, 4_000),
          resources: e.resources,
          occurredAt: new Date(e.occurred_at),
          source: job.source ?? "mcp",
        })),
      )
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) return "duplicate" as const;
    const now = new Date();
    await enqueueLakeRecords(
      tx,
      job.tenantId,
      inserted.map((e) =>
        actionRecord({
          id: e.id,
          tenantId: job.tenantId,
          memberId: job.memberId,
          agentId: job.agentId,
          source: e.source,
          sessionId,
          taskId: e.taskId,
          private: sess.private,
          kind: e.kind,
          summary: e.summaryRedacted,
          resources: e.resources,
          occurredAt: e.occurredAt,
          ingestedAt: now,
        }),
      ),
    );
    // Live awareness: does what this session just touched overlap anyone else's work?
    await detectOverlaps(tx, job.tenantId, sessionId);
    return "stored" as const;
  });
}

/** "What I'm working on now": replaces the session's previous intent, then checks overlaps. */
export async function processIntent(deps: ProcessDeps, job: IngestJob): Promise<ProcessOutcome> {
  const env = await loadEnvelope(deps, job);
  if (!env) return "dropped_expired";
  const parsed = announceIntentInput.parse(env.payload);
  if (!parsed.session) throw new Error(`Intent ${job.id} has no session`);
  const input = { ...parsed, session: parsed.session };
  if (await deps.db.withTenant(job.tenantId, (tx) => memberOptedOut(tx, job.memberId))) {
    return dropRaw(deps, job, "dropped_opt_out");
  }
  const r = await deps.redactorFor(job.tenantId);
  const session = await redactSession(r, input.session);
  const description = await r.redact(input.description);
  const resources = await Promise.all(input.resources.map(async (x) => (await r.redact(x)).text));

  return deps.db.withTenant(job.tenantId, async (tx) => {
    if (await memberOptedOut(tx, job.memberId)) return "dropped_opt_out" as const;
    const sess = await upsertSession(tx, job, input.session, session.context);
    await tx
      .update(intents)
      .set({ status: "done", updatedAt: new Date() })
      .where(and(eq(intents.sessionId, sess.id), eq(intents.status, "active")));
    const inserted = await tx
      .insert(intents)
      .values({
        id: job.id,
        tenantId: job.tenantId,
        sessionId: sess.id,
        memberId: job.memberId,
        descriptionRedacted: clip(description.text, 2_000),
        resources,
      })
      .onConflictDoNothing()
      .returning({ id: intents.id });
    if (inserted.length === 0) return "duplicate" as const;
    await detectOverlaps(tx, job.tenantId, sess.id);
    return "stored" as const;
  });
}

/** Wires the handlers to their queues. Used by the worker app. */
export async function startIngestWorkers(
  queue: Pick<QueueClient, "work" | "send">,
  deps: ProcessDeps,
): Promise<void> {
  const run =
    (fn: (d: ProcessDeps, j: IngestJob) => Promise<ProcessOutcome>, name: string) =>
    async (job: { data: IngestJob }) => {
      const outcome = await fn(deps, job.data);
      deps.log?.(`${name}.${outcome}`, { id: job.data.id, tenantId: job.data.tenantId });
      // A new task gets a category next.
      if (fn === processTask && outcome === "stored") {
        await queue.send(
          "categorize.task",
          { tenantId: job.data.tenantId, taskId: job.data.id },
          { id: idFromKey([job.data.id, "categorize", "logged"]) },
        );
      }
    };
  await queue.work<IngestJob>("ingest.task", run(processTask, "ingest.task"));
  await queue.work<IngestJob>("ingest.outcome", run(processOutcome, "ingest.outcome"));
  await queue.work<IngestJob>("ingest.actions", run(processActions, "ingest.actions"));
  await queue.work<IngestJob>("ingest.intent", run(processIntent, "ingest.intent"));
}
