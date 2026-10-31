// Lake table definitions: the single source for provisioning (Iceberg schemas), the row
// builders and the local lake. Columns only ever hold redacted text.
//
// Types are Iceberg primitives. Lists are stored as JSON strings: primitive-only schemas
// are what S3 Tables' CreateTable accepts in its simple form, and Athena reads them with
// json_parse(). Every table is partitioned by day of event_time.
import { LAKE_TABLES, type LakeTableName } from "@mm/db";

export { LAKE_TABLES, type LakeTableName };

export type IcebergType = "string" | "boolean" | "int" | "long" | "double" | "timestamptz";

export interface LakeColumn {
  name: string;
  type: IcebergType;
  required?: boolean;
}

export interface LakeTableDef {
  name: LakeTableName;
  columns: LakeColumn[];
  /** Partition transforms on columns, e.g. day(event_time). */
  partitions: { column: string; transform: "day" | "identity"; name: string }[];
}

const common: LakeColumn[] = [
  { name: "event_id", type: "string", required: true },
  { name: "tenant_id", type: "string", required: true },
  // Null for connector rows whose author hasn't linked an account; actor_key is set then.
  { name: "member_id", type: "string" },
  { name: "actor_key", type: "string" },
  { name: "agent_id", type: "string" },
  { name: "source", type: "string", required: true },
];
const times: LakeColumn[] = [
  { name: "event_time", type: "timestamptz", required: true },
  { name: "ingested_at", type: "timestamptz", required: true },
];
const byDay = [{ column: "event_time", transform: "day" as const, name: "event_day" }];

export const LAKE_TABLE_DEFS: Record<LakeTableName, LakeTableDef> = {
  actions: {
    name: "actions",
    columns: [
      ...common,
      { name: "session_id", type: "string", required: true },
      { name: "task_id", type: "string" },
      { name: "private", type: "boolean", required: true },
      { name: "kind", type: "string", required: true },
      { name: "summary", type: "string", required: true },
      /** JSON array of resource keys, e.g. ["git:github.com/acme/api:src/a.ts#L1-9"]. */
      { name: "resources", type: "string", required: true },
      ...times,
    ],
    partitions: byDay,
  },
  tasks: {
    name: "tasks",
    columns: [
      ...common,
      { name: "session_id", type: "string" },
      { name: "private", type: "boolean", required: true },
      { name: "title", type: "string", required: true },
      { name: "summary", type: "string", required: true },
      { name: "category_hint", type: "string" },
      /** JSON array, e.g. ["github:pr:acme/api#12"]. */
      { name: "external_refs", type: "string", required: true },
      /** JSON object of structured features. */
      { name: "features", type: "string", required: true },
      { name: "started_at", type: "timestamptz" },
      { name: "completed_at", type: "timestamptz" },
      ...times,
    ],
    partitions: byDay,
  },
  task_categories: {
    name: "task_categories",
    columns: [
      ...common,
      { name: "task_id", type: "string", required: true },
      { name: "pack", type: "string", required: true },
      { name: "category", type: "string", required: true },
      /** rule, hint, llm or fallback. */
      { name: "method", type: "string", required: true },
      { name: "confidence", type: "double", required: true },
      ...times,
    ],
    partitions: byDay,
  },
  judgments: {
    name: "judgments",
    columns: [
      ...common,
      { name: "task_id", type: "string", required: true },
      { name: "pack", type: "string", required: true },
      { name: "ruleset_version", type: "int", required: true },
      { name: "category", type: "string" },
      /** success, failure, neutral or inconclusive. */
      { name: "verdict", type: "string", required: true },
      /** JSON array of rule outcomes. */
      { name: "reasons", type: "string", required: true },
      /** JSON object: the baseline the verdict was measured against. */
      { name: "baseline", type: "string", required: true },
      { name: "input_hash", type: "string", required: true },
      ...times,
    ],
    partitions: byDay,
  },
  channel_messages: {
    name: "channel_messages",
    columns: [
      ...common,
      { name: "channel_id", type: "string", required: true },
      { name: "seq", type: "long", required: true },
      { name: "session_id", type: "string", required: true },
      { name: "type", type: "string", required: true },
      { name: "body", type: "string", required: true },
      ...times,
    ],
    partitions: byDay,
  },
  skill_usage: {
    name: "skill_usage",
    columns: [
      ...common,
      { name: "skill_id", type: "string", required: true },
      { name: "version", type: "int", required: true },
      { name: "task_id", type: "string" },
      { name: "session_id", type: "string" },
      { name: "adherence", type: "string", required: true },
      ...times,
    ],
    partitions: byDay,
  },
  metric_observations: {
    name: "metric_observations",
    columns: [
      ...common,
      { name: "task_id", type: "string", required: true },
      { name: "metric", type: "string", required: true },
      { name: "value", type: "double", required: true },
      { name: "n", type: "long", required: true },
      { name: "note", type: "string" },
      ...times,
    ],
    partitions: byDay,
  },
};
