// API side of ingest: the fast path an agent waits on. It checks opt-out and scope,
// stores the raw payload in bronze, queues a pointer to it, and returns an id.
// Nothing is redacted or written to Postgres here; the worker does that.
import { randomUUID } from "node:crypto";
import { idFromKey, type AuthenticatedAgent } from "@mm/db";
import type { QueueClient, QueueName } from "@mm/db/queue";
import { bronzeKey, type BronzeKind, type BronzeStore } from "./bronze.ts";
import type {
  ActionBatchInput,
  AnnounceIntentInput,
  LogTaskInput,
  ReportOutcomeInput,
} from "./schemas.ts";

export type IngestSource = "mcp" | "bridge";

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
  /** How it arrived: the remote MCP server or the local bridge. */
  source?: IngestSource;
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
export { idFromKey };

async function accept<T>(
  deps: AcceptDeps,
  agent: AuthenticatedAgent,
  kind: BronzeKind,
  queueName: QueueName,
  id: string,
  payload: T,
  source: IngestSource,
): Promise<AcceptResult> {
  if (!agent.scopes.includes("capture:write")) {
    throw new IngestForbiddenError("This agent key does not have the capture:write scope.");
  }
  // Opted-out members' data is dropped here, before anything is stored.
  if (agent.captureOptOut) return { captured: false, reason: "capture_opt_out" };

  const now = (deps.now ?? (() => new Date()))();
  const key = bronzeKey(agent.tenantId, agent.memberId, kind, id, now);
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
    source,
  };
  // The job id is the record id, so a retried request queues nothing new.
  await deps.queue.send(queueName, job, { id });
  return { captured: true, id };
}

export function acceptTask(
  deps: AcceptDeps,
  agent: AuthenticatedAgent,
  input: LogTaskInput,
  source: IngestSource = "mcp",
) {
  const id = input.idempotency_key
    ? idFromKey([agent.tenantId, agent.memberId, "task", input.idempotency_key])
    : randomUUID();
  return accept(deps, agent, "task", "ingest.task", id, input, source);
}

export function acceptOutcome(
  deps: AcceptDeps,
  agent: AuthenticatedAgent,
  input: ReportOutcomeInput,
  source: IngestSource = "mcp",
) {
  const id = input.idempotency_key
    ? idFromKey([agent.tenantId, agent.memberId, "outcome", input.idempotency_key])
    : randomUUID();
  return accept(deps, agent, "outcome", "ingest.outcome", id, input, source);
}

export function acceptActions(
  deps: AcceptDeps,
  agent: AuthenticatedAgent,
  input: ActionBatchInput,
  source: IngestSource = "mcp",
) {
  // Event ids are client-generated, so the batch id derives from them: a resent batch dedupes.
  const id = idFromKey([
    agent.tenantId,
    agent.memberId,
    "actions",
    ...input.events.map((e) => e.id),
  ]);
  return accept(deps, agent, "actions", "ingest.actions", id, input, source);
}

export function acceptIntent(
  deps: AcceptDeps,
  agent: AuthenticatedAgent,
  input: AnnounceIntentInput,
  source: IngestSource = "mcp",
) {
  if (!input.session)
    throw new IngestForbiddenError("announce_intent needs your session (id, and repo if any).");
  return accept(deps, agent, "intent", "ingest.intent", randomUUID(), input, source);
}
