// Worker side of member erasure. Postgres rows were deleted when the request was made;
// this removes raw payloads (bronze) and lake rows, in two lake passes: the second catches
// rows that were still buffered in Firehose during the first.
import { appendAuditEvent } from "@mm/audit";
import { erasureRepo, type MasterMindDb } from "@mm/db";
import type { LakeAdmin } from "./types.ts";

export interface ErasureOptions {
  db: MasterMindDb;
  /** Null when no lake is configured (rows then only ever lived in Postgres and bronze). */
  lake: LakeAdmin | null;
  /**
   * Same setting as the publisher: when true, tenants without a provisioned lake have no
   * lake rows (theirs wait in the outbox, which erasure already emptied) and are skipped.
   */
  requireProvisioned: boolean;
  /** Deletes every raw payload of one member. Must be idempotent. */
  deleteRaw: (tenantId: string, memberId: string) => Promise<void>;
  now?: () => Date;
  /** Wait before the second lake pass. Longer than Firehose's buffer interval. */
  secondPassDelayMs?: number;
  /**
   * How long deleted rows can still exist physically: Iceberg snapshot expiry plus
   * unreferenced-file cleanup and the raw bucket's old-version expiry. Recorded per request.
   */
  physicalErasureDelayMs?: number;
  maxAttempts?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export async function processErasures(options: ErasureOptions): Promise<number> {
  const now = options.now ?? (() => new Date());
  const secondPassDelay = options.secondPassDelayMs ?? 15 * MINUTE;
  // 7 days of snapshots + 3 days until unreferenced files are removed + 1 day to purge them.
  const physicalDelay = options.physicalErasureDelayMs ?? 11 * DAY;
  const maxAttempts = options.maxAttempts ?? 10;
  let handled = 0;

  for (const tenant of await options.db.system.listTenantsForJobs()) {
    const due = await options.db.withTenant(tenant.tenantId, (tx) =>
      erasureRepo.dueErasureRequests(tx, now()),
    );
    for (const req of due) {
      const ctx = { tenantId: tenant.tenantId, requestId: req.id };
      const lake = tenant.lakeReady || !options.requireProvisioned ? options.lake : null;
      try {
        if (req.status === "pending") {
          await options.deleteRaw(tenant.tenantId, req.subjectMemberId);
          if (lake) await lake.deleteMemberRows(tenant.tenantId, req.subjectMemberId);
          const t = now();
          await options.db.withTenant(tenant.tenantId, async (tx) => {
            await erasureRepo.updateErasureRequest(tx, req.id, {
              status: "first_pass_done",
              bronzeDeletedAt: t,
              lakeFirstPassAt: t,
              lakeSecondPassDue: new Date(t.getTime() + secondPassDelay),
              lastError: null,
            });
            await appendAuditEvent(tx, tenant.tenantId, {
              actorType: "system",
              actorId: null,
              action: "member.erasure_first_pass",
              targetType: "erasure_request",
              targetId: req.id,
              payload: { lake: lake ? "deleted" : "not_provisioned" },
            });
          });
        } else {
          let remaining = 0;
          if (lake) {
            await lake.deleteMemberRows(tenant.tenantId, req.subjectMemberId);
            const counts = await lake.memberRowCounts(tenant.tenantId, req.subjectMemberId);
            remaining = Object.values(counts).reduce((a, b) => a + b, 0);
            if (remaining > 0) throw new Error(`${remaining} lake rows remain after delete`);
          }
          const t = now();
          await options.db.withTenant(tenant.tenantId, async (tx) => {
            await erasureRepo.updateErasureRequest(tx, req.id, {
              status: "done",
              lakeSecondPassAt: t,
              physicallyErasedBy: new Date(t.getTime() + physicalDelay),
              lastError: null,
            });
            await appendAuditEvent(tx, tenant.tenantId, {
              actorType: "system",
              actorId: null,
              action: "member.erasure_completed",
              targetType: "erasure_request",
              targetId: req.id,
              payload: { physically_erased_by: new Date(t.getTime() + physicalDelay) },
            });
          });
        }
        handled++;
        options.log?.("erasure.step", { ...ctx, from: req.status });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const failed = req.attempts + 1 >= maxAttempts;
        await options.db.withTenant(tenant.tenantId, (tx) =>
          erasureRepo.updateErasureRequest(tx, req.id, {
            lastError: message.slice(0, 2000),
            incrementAttempts: true,
            ...(failed ? { status: "failed" as const } : {}),
          }),
        );
        options.log?.("erasure.error", { ...ctx, attempt: req.attempts + 1, failed, message });
      }
    }
  }
  return handled;
}
