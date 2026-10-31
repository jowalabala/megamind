// Builds lake rows from what ingest just wrote to Postgres. Already-redacted values only.
import type { CaptureSource, LakeTableName } from "@mm/db";

export interface LakeRecord {
  table: LakeTableName;
  eventId: string;
  /** Null for connector rows not yet linked to a member. */
  memberId: string | null;
  row: Record<string, unknown>;
}

const iso = (d: Date | string | null | undefined) =>
  d == null ? null : (d instanceof Date ? d : new Date(d)).toISOString();

interface Base {
  tenantId: string;
  memberId: string | null;
  actorKey?: string | null;
  agentId: string | null;
  source: CaptureSource;
  ingestedAt: Date;
}

const base = (b: Base) => ({
  tenant_id: b.tenantId,
  member_id: b.memberId,
  actor_key: b.actorKey ?? null,
  agent_id: b.agentId,
  source: b.source,
  ingested_at: iso(b.ingestedAt),
});

export function actionRecord(
  e: Base & {
    id: string;
    sessionId: string;
    taskId: string | null;
    private: boolean;
    kind: string;
    summary: string;
    resources: string[];
    occurredAt: Date;
  },
): LakeRecord {
  return {
    table: "actions",
    eventId: e.id,
    memberId: e.memberId,
    row: {
      event_id: e.id,
      ...base(e),
      session_id: e.sessionId,
      task_id: e.taskId,
      private: e.private,
      kind: e.kind,
      summary: e.summary,
      resources: JSON.stringify(e.resources),
      event_time: iso(e.occurredAt),
    },
  };
}

export function taskRecord(
  t: Base & {
    id: string;
    sessionId: string | null;
    private: boolean;
    title: string;
    summary: string;
    categoryHint: string | null;
    externalRefs: string[];
    features: Record<string, unknown>;
    startedAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
  },
): LakeRecord {
  return {
    table: "tasks",
    eventId: t.id,
    memberId: t.memberId,
    row: {
      event_id: t.id,
      ...base(t),
      session_id: t.sessionId,
      private: t.private,
      title: t.title,
      summary: t.summary,
      category_hint: t.categoryHint,
      external_refs: JSON.stringify(t.externalRefs),
      features: JSON.stringify(t.features),
      started_at: iso(t.startedAt),
      completed_at: iso(t.completedAt),
      event_time: iso(t.createdAt),
    },
  };
}

export function metricRecord(
  m: Base & {
    id: string;
    taskId: string;
    metric: string;
    value: number;
    n: number;
    note: string | null;
    observedAt: Date;
  },
): LakeRecord {
  return {
    table: "metric_observations",
    eventId: m.id,
    memberId: m.memberId,
    row: {
      event_id: m.id,
      ...base(m),
      task_id: m.taskId,
      metric: m.metric,
      value: m.value,
      n: m.n,
      note: m.note,
      event_time: iso(m.observedAt),
    },
  };
}

export function categoryRecord(
  c: Base & {
    /** Unique per categorization, so a re-categorized task gets a new row. */
    id: string;
    taskId: string;
    pack: string;
    category: string;
    method: string;
    confidence: number;
    categorizedAt: Date;
  },
): LakeRecord {
  return {
    table: "task_categories",
    eventId: c.id,
    memberId: c.memberId,
    row: {
      event_id: c.id,
      ...base(c),
      task_id: c.taskId,
      pack: c.pack,
      category: c.category,
      method: c.method,
      confidence: c.confidence,
      event_time: iso(c.categorizedAt),
    },
  };
}

export function judgmentRecord(
  j: Base & {
    /** Unique per (judgment, inputs): a re-judgment with new inputs is a new row. */
    id: string;
    taskId: string;
    pack: string;
    rulesetVersion: number;
    category: string | null;
    verdict: string;
    reasons: unknown[];
    baseline: Record<string, unknown>;
    inputHash: string;
    judgedAt: Date;
  },
): LakeRecord {
  return {
    table: "judgments",
    eventId: j.id,
    memberId: j.memberId,
    row: {
      event_id: j.id,
      ...base(j),
      task_id: j.taskId,
      pack: j.pack,
      ruleset_version: j.rulesetVersion,
      category: j.category,
      verdict: j.verdict,
      reasons: JSON.stringify(j.reasons),
      baseline: JSON.stringify(j.baseline),
      input_hash: j.inputHash,
      event_time: iso(j.judgedAt),
    },
  };
}

export function channelMessageRecord(
  m: Base & {
    id: string;
    channelId: string;
    seq: number;
    sessionId: string;
    type: string;
    body: string;
    sentAt: Date;
  },
): LakeRecord {
  return {
    table: "channel_messages",
    eventId: m.id,
    memberId: m.memberId,
    row: {
      event_id: m.id,
      ...base(m),
      channel_id: m.channelId,
      seq: m.seq,
      session_id: m.sessionId,
      type: m.type,
      body: m.body,
      event_time: iso(m.sentAt),
    },
  };
}
