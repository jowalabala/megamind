// Outbox -> lake. Runs in the worker every few seconds.
//
// Each batch is claimed with FOR UPDATE SKIP LOCKED inside a tenant transaction, sent, and
// deleted in the same transaction, so several workers never send the same rows at once.
// If the commit fails after a successful send, rows are sent again: delivery is
// at-least-once and lake readers de-duplicate on event_id.
import { asc, inArray, lakeOutbox, type MasterMindDb } from "@mm/db";
import type { LakeSink, OutboxRecord } from "./types.ts";

export interface PublishOptions {
  db: MasterMindDb;
  sink: LakeSink;
  batchSize?: number;
  /** Max batches per tenant per call, so one busy tenant can't starve the rest. */
  maxBatchesPerTenant?: number;
  /** Skip tenants whose lake isn't provisioned yet (their rows wait). True in AWS. */
  requireProvisioned?: boolean;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface PublishResult {
  published: number;
  failed: number;
}

export async function publishOutbox(options: PublishOptions): Promise<PublishResult> {
  const batchSize = options.batchSize ?? 200;
  const maxBatches = options.maxBatchesPerTenant ?? 10;
  const total: PublishResult = { published: 0, failed: 0 };

  for (const tenant of await options.db.system.listTenantsForJobs()) {
    if (options.requireProvisioned && !tenant.lakeReady) continue;
    for (let i = 0; i < maxBatches; i++) {
      const r = await publishBatch(options, tenant.tenantId, batchSize);
      total.published += r.published;
      total.failed += r.failed;
      if (r.published + r.failed < batchSize || r.failed > 0) break;
    }
  }
  if (total.published || total.failed) options.log?.("lake.published", { ...total });
  return total;
}

async function publishBatch(
  options: PublishOptions,
  tenantId: string,
  batchSize: number,
): Promise<PublishResult> {
  return options.db.withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(lakeOutbox)
      .orderBy(asc(lakeOutbox.id))
      .limit(batchSize)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return { published: 0, failed: 0 };

    const records: OutboxRecord[] = rows.map((r) => ({
      id: r.id,
      table: r.lakeTable,
      eventId: r.eventId,
      row: r.row,
    }));
    const { failedIds } = await options.sink.put(tenantId, records);
    const failed = new Set(failedIds);
    const done = rows.map((r) => r.id).filter((id) => !failed.has(id));
    if (done.length > 0) await tx.delete(lakeOutbox).where(inArray(lakeOutbox.id, done));
    return { published: done.length, failed: failed.size };
  });
}
