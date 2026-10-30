// Append-only, hash-chained audit log. Each tenant has its own chain:
//   hash_n = sha256(canonical_json(event_n fields + prev_hash))
// Changing, removing or reordering any past event breaks every hash after it,
// and verifyAuditChain() reports where.
import { createHash, randomUUID } from "node:crypto";
import { asc, auditChainHeads, auditEvents, eq, sql, type TenantTx } from "@mm/db";

export const GENESIS_HASH = "0".repeat(64);

export type ActorType = "member" | "agent" | "system";

export interface AuditEventInput {
  actorType: ActorType;
  actorId: string | null;
  /** Dotted lowercase verb, e.g. "tenant.created", "member.invited", "skill.approved". */
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  /** Must not contain secrets or raw PII; it is kept for the life of the tenant. */
  payload?: Record<string, unknown>;
}

export interface AuditEvent extends Required<Omit<AuditEventInput, "payload">> {
  tenantId: string;
  seq: number;
  id: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

/** JSON with object keys sorted at every level, so the same data always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("Audit payloads cannot contain NaN or Infinity");
    }
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function hashEvent(e: Omit<AuditEvent, "hash">): string {
  const material = canonicalJson({
    tenantId: e.tenantId,
    seq: e.seq,
    id: e.id,
    occurredAt: e.occurredAt.toISOString(),
    actorType: e.actorType,
    actorId: e.actorId,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId,
    payload: e.payload,
    prevHash: e.prevHash,
  });
  return createHash("sha256").update(material).digest("hex");
}

/**
 * Appends one event to the current tenant's chain inside the caller's transaction, so the
 * event commits or rolls back together with the change it describes.
 */
export async function appendAuditEvent(
  tx: TenantTx,
  tenantId: string,
  input: AuditEventInput,
): Promise<AuditEvent> {
  // Create the head row on first use, then lock it. Concurrent writers for the same
  // tenant queue here, which keeps sequence numbers gapless and the chain linear.
  await tx
    .insert(auditChainHeads)
    .values({ tenantId, lastSeq: 0, lastHash: GENESIS_HASH })
    .onConflictDoNothing();
  const heads = await tx
    .select()
    .from(auditChainHeads)
    .where(eq(auditChainHeads.tenantId, tenantId))
    .for("update");
  const head = heads[0];
  if (!head) throw new Error("Audit chain head not visible; is the tenant context set?");

  const base: Omit<AuditEvent, "hash"> = {
    tenantId,
    seq: head.lastSeq + 1,
    id: randomUUID(),
    occurredAt: new Date(),
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    // Round-trip through JSON so what we hash is exactly what jsonb will hand back.
    payload: JSON.parse(canonicalJson(input.payload ?? {})) as Record<string, unknown>,
    prevHash: head.lastHash,
  };
  const event: AuditEvent = { ...base, hash: hashEvent(base) };

  await tx.insert(auditEvents).values(event);
  await tx
    .update(auditChainHeads)
    .set({ lastSeq: event.seq, lastHash: event.hash })
    .where(eq(auditChainHeads.tenantId, tenantId));
  return event;
}

export type ChainVerification =
  | { ok: true; count: number; headHash: string }
  | { ok: false; brokenAtSeq: number; reason: string };

/** Recomputes the current tenant's whole chain and checks it against the stored head. */
export async function verifyAuditChain(tx: TenantTx, tenantId: string): Promise<ChainVerification> {
  const rows = await tx
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.tenantId, tenantId))
    .orderBy(asc(auditEvents.seq));

  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  for (const row of rows) {
    if (row.seq !== expectedSeq) {
      return { ok: false, brokenAtSeq: expectedSeq, reason: "missing or reordered event" };
    }
    if (row.prevHash !== prevHash) {
      return { ok: false, brokenAtSeq: row.seq, reason: "prev_hash does not match previous event" };
    }
    const { hash, ...rest } = row;
    if (hashEvent(rest as Omit<AuditEvent, "hash">) !== hash) {
      return { ok: false, brokenAtSeq: row.seq, reason: "event contents do not match its hash" };
    }
    prevHash = hash;
    expectedSeq += 1;
  }

  const head = await tx.execute<{ last_seq: string; last_hash: string }>(
    sql`SELECT last_seq, last_hash FROM audit_chain_heads WHERE tenant_id = ${tenantId}`,
  );
  const h = head.rows[0];
  const count = rows.length;
  if (count > 0 && (!h || Number(h.last_seq) !== count || h.last_hash !== prevHash)) {
    return {
      ok: false,
      brokenAtSeq: count,
      reason: "chain head does not match the last event (truncated?)",
    };
  }
  return { ok: true, count, headHash: prevHash };
}
