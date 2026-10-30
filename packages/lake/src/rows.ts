// Builds lake rows from what ingest just wrote to Postgres. Already-redacted values only.
import type { CaptureSource, LakeTableName } from "@mm/db";

export interface LakeRecord {
  table: LakeTableName;
  eventId: string;
  memberId: string;
  row: Record<string, unknown>;
}

const iso = (d: Date | string | null | undefined) =>
  d == null ? null : (d instanceof Date ? d : new Date(d)).toISOString();

interface Base {
  tenantId: string;
  memberId: string;
  agentId: string | null;
  source: CaptureSource;
  ingestedAt: Date;
}

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
      tenant_id: e.tenantId,
      member_id: e.memberId,
      agent_id: e.agentId,
      source: e.source,
      session_id: e.sessionId,
      task_id: e.taskId,
      private: e.private,
      kind: e.kind,
      summary: e.summary,
      resources: JSON.stringify(e.resources),
      event_time: iso(e.occurredAt),
      ingested_at: iso(e.ingestedAt),
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
      tenant_id: t.tenantId,
      member_id: t.memberId,
      agent_id: t.agentId,
      source: t.source,
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
      ingested_at: iso(t.ingestedAt),
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
      tenant_id: m.tenantId,
      member_id: m.memberId,
      agent_id: m.agentId,
      source: m.source,
      task_id: m.taskId,
      metric: m.metric,
      value: m.value,
      n: m.n,
      note: m.note,
      event_time: iso(m.observedAt),
      ingested_at: iso(m.ingestedAt),
    },
  };
}
