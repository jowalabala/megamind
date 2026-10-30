// API side of ingest: the fast path an agent waits on. It checks opt-out and scope,
// stores the raw payload in bronze, queues a pointer to it, and returns an id.
// Nothing is redacted or written to Postgres here; the worker does that.
import { createHash, randomUUID } from "node:crypto";
import type { AuthenticatedAgent } from "@mm/db";
import type { QueueClient, QueueName } from "@mm/db/queue";
import { bronzeKey, type BronzeKind, type BronzeStore } from "./bronze.ts";
import type { ActionBatchInput, LogTaskInput, ReportOutcomeInput } from "./schemas.ts";

export interface AcceptDeps {
  queue: Pick<QueueClient, "send">;
  bronze: BronzeStore;
  now?: () => Date;
}

export type AcceptResult =
  { captured: true; id: string } | { captured: false; reason: "capture_opt_out" };

/** What the worker receives. Pointers and ids only: never captured content. */
export interface IngestJob {
  tenantId: string;
  memberId: string;
  agentId: string;
  /** Task id, observation id or action batch id. */
  id: string;
  bronzeKey: string;
}

/** What bronze holds for one request. */
export interface BronzeEnvelope<T> {
  v: 1;
  kind: BronzeKind;
  tenantId: string;
  memberId: string;
  agentId: string;
  receivedAt: string;
  payload: T;
}

export class IngestForbiddenError extends Error {
  override name = "IngestForbiddenError";
}

/** Same key from the same member always maps to the same id, so retries are stored once. */
export function idFromKey(parts: string[]): string {
  const h = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  // Shaped as a version 8 (custom) UUID.
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function accept<T>(
  deps: AcceptDeps,
  agent: AuthenticatedAgent,
  kind: BronzeKind,
  queueName: QueueName,
  id: string,
  payload: T,
): Promise<AcceptResult> {
  if (!agent.scopes.includes("capture:write")) {
    throw new IngestForbiddenError("This agent key does not have the capture:write scope.");
  }
  // Opted-out members' data is dropped here, before anything is stored.
  if (agent.captureOptOut) return { captured: false, reason: "capture_opt_out" };

  const now = (deps.now ?? (() => new Date()))();
  const key = bronzeKey(agent.tenantId, kind, id, now);
  const envelope: BronzeEnvelope<T> = {
    v: 1,
    kind,
    tenantId: agent.tenantId,
    memberId: agent.memberId,
    agentId: agent.agentId,
    receivedAt: now.toISOString(),
    payload,
  };
  await deps.bronze.put(key, envelope);
  const job: IngestJob = {
    tenantId: agent.tenantId,
    memberId: agent.memberId,
    agentId: agent.agentId,
    id,
    bronzeKey: key,
  };
  // The job id is the record id, so a retried request queues nothing new.
  await deps.queue.send(queueName, job, { id });
  return { captured: true, id };
}

export function acceptTask(deps: AcceptDeps, agent: AuthenticatedAgent, input: LogTaskInput) {
  const id = input.idempotency_key
    ? idFromKey([agent.tenantId, agent.memberId, "task", input.idempotency_key])
    : randomUUID();
  return accept(deps, agent, "task", "ingest.task", id, input);
}

export function acceptOutcome(
  deps: AcceptDeps,
  agent: AuthenticatedAgent,
  input: ReportOutcomeInput,
) {
  const id = input.idempotency_key
    ? idFromKey([agent.tenantId, agent.memberId, "outcome", input.idempotency_key])
    : randomUUID();
  return accept(deps, agent, "outcome", "ingest.outcome", id, input);
}

export function acceptActions(
  deps: AcceptDeps,
  agent: AuthenticatedAgent,
  input: ActionBatchInput,
) {
  // Event ids are client-generated, so the batch id derives from them: a resent batch dedupes.
  const id = idFromKey([
    agent.tenantId,
    agent.memberId,
    "actions",
    ...input.events.map((e) => e.id),
  ]);
  return accept(deps, agent, "actions", "ingest.actions", id, input);
}
