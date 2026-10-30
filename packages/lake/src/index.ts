export { processErasures, type ErasureOptions } from "./erasure.ts";
export { localLake, type LocalLake } from "./local.ts";
export * from "./naming.ts";
export { enqueueLakeRecords } from "./outbox.ts";
export { publishOutbox, type PublishOptions, type PublishResult } from "./publisher.ts";
export { actionRecord, categoryRecord, metricRecord, taskRecord, type LakeRecord } from "./rows.ts";
export {
  LAKE_TABLE_DEFS,
  LAKE_TABLES,
  type IcebergType,
  type LakeColumn,
  type LakeTableDef,
  type LakeTableName,
} from "./tables.ts";
export type { LakeActionRow, LakeAdmin, LakeCounts, LakeSink, OutboxRecord } from "./types.ts";
