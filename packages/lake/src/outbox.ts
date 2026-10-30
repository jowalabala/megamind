// Writes lake rows into the transactional outbox, in the caller's transaction, so a row
// reaches the lake if and only if its Postgres twin was committed.
import { lakeOutbox, type TenantTx } from "@mm/db";
import type { LakeRecord } from "./rows.ts";

export async function enqueueLakeRecords(
  tx: TenantTx,
  tenantId: string,
  records: LakeRecord[],
): Promise<void> {
  if (records.length === 0) return;
  await tx.insert(lakeOutbox).values(
    records.map((r) => ({
      tenantId,
      memberId: r.memberId,
      lakeTable: r.table,
      eventId: r.eventId,
      row: r.row,
    })),
  );
}
