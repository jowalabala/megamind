// Sends outbox rows to the Firehose stream that writes the Iceberg tables. Each record
// carries its destination (tenant namespace + table); the stream routes on those two
// fields with a JQ metadata-extraction step (see infra/lib/lake-stack.ts).
import { FirehoseClient, PutRecordBatchCommand } from "@aws-sdk/client-firehose";
import { tenantNamespace } from "../naming.ts";
import type { LakeSink, OutboxRecord } from "../types.ts";

/** Firehose limits: 500 records and 4 MiB per call, 1,000 KiB per record. */
const MAX_RECORDS = 500;
const MAX_BATCH_BYTES = 4 * 1024 * 1024 - 64 * 1024;
const MAX_RECORD_BYTES = 1000 * 1024;

export const ROUTE_NAMESPACE_FIELD = "_mm_namespace";
export const ROUTE_TABLE_FIELD = "_mm_table";

export function firehoseSink(options: {
  streamName: string;
  client?: Pick<FirehoseClient, "send">;
  region?: string;
  log?: (event: string, fields: Record<string, unknown>) => void;
}): LakeSink {
  const client = options.client ?? new FirehoseClient({ region: options.region });

  return {
    async put(tenantId, records) {
      const ns = tenantNamespace(tenantId);
      const failedIds: number[] = [];
      let batch: { rec: OutboxRecord; data: Uint8Array }[] = [];
      let bytes = 0;

      const flush = async () => {
        if (batch.length === 0) return;
        const sent = batch;
        batch = [];
        bytes = 0;
        try {
          const res = await client.send(
            new PutRecordBatchCommand({
              DeliveryStreamName: options.streamName,
              Records: sent.map((b) => ({ Data: b.data })),
            }),
          );
          // Partial failures come back per record, in request order.
          res.RequestResponses?.forEach((r, i) => {
            if (r.ErrorCode) failedIds.push(sent[i]!.rec.id);
          });
        } catch (err) {
          options.log?.("lake.firehose_error", { message: (err as Error).message });
          failedIds.push(...sent.map((b) => b.rec.id));
        }
      };

      for (const rec of records) {
        const data = Buffer.from(
          JSON.stringify({
            ...rec.row,
            [ROUTE_NAMESPACE_FIELD]: ns,
            [ROUTE_TABLE_FIELD]: rec.table,
          }) + "\n",
        );
        if (data.byteLength > MAX_RECORD_BYTES) {
          // Can't be delivered as is; keep it in the outbox and make it visible.
          options.log?.("lake.record_too_large", { eventId: rec.eventId, bytes: data.byteLength });
          failedIds.push(rec.id);
          continue;
        }
        if (batch.length === MAX_RECORDS || bytes + data.byteLength > MAX_BATCH_BYTES) {
          await flush();
        }
        batch.push({ rec, data });
        bytes += data.byteLength;
      }
      await flush();
      return { failedIds };
    },
  };
}
