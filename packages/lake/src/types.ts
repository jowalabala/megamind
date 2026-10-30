import type { LakeTableName } from "./tables.ts";

/** One outbox row on its way to the lake. */
export interface OutboxRecord {
  /** Outbox row id; reported back when that record failed. */
  id: number;
  table: LakeTableName;
  eventId: string;
  row: Record<string, unknown>;
}

/** Where published rows go: Firehose in AWS, files in development, memory in tests. */
export interface LakeSink {
  /** Returns the outbox ids that were NOT accepted; they stay in the outbox for the next try. */
  put(tenantId: string, records: OutboxRecord[]): Promise<{ failedIds: number[] }>;
}

export type LakeCounts = Record<LakeTableName, number>;

export interface LakeActionRow {
  event_id: string;
  member_id: string;
  kind: string;
  summary: string;
  resources: string[];
  event_time: string;
}

/** Tenant-scoped reads and deletes on the lake (Athena in AWS). */
export interface LakeAdmin {
  tableCounts(tenantId: string): Promise<LakeCounts>;
  memberRowCounts(tenantId: string, memberId: string): Promise<LakeCounts>;
  /** Logical delete: the rows disappear from every query now; old snapshots expire later. */
  deleteMemberRows(tenantId: string, memberId: string): Promise<void>;
  recentActions(
    tenantId: string,
    options?: { limit?: number; resource?: string },
  ): Promise<LakeActionRow[]>;
}
