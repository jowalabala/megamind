// The HubSpot connector: one sequence -> one task (source "hubspot"), credited to the owner
// who created it, plus outcome metrics once enough of its enrollments have had time to reply.
//
// Owners are matched to members by work email inside the tenant's own portal. Metrics are
// written once, when the sequence is old enough and enough contacts have been enrolled, so a
// judgment never changes after the fact.
import { appendAuditEvent } from "@mm/audit";
import {
  and,
  connectionRepo,
  eq,
  externalRefs,
  hubspotSequences,
  idFromKey,
  isNull,
  members,
  metricObservations,
  sql,
  tasks,
  type Connection,
  type MasterMindDb,
} from "@mm/db";
import type { RedactorFor } from "@mm/ingest";
import { enqueueLakeRecords, metricRecord, taskRecord } from "@mm/lake";
import type { Vault } from "@mm/vault";
import {
  hubspotClient,
  HubspotRateLimitedError,
  listOwners,
  listSequences,
  refreshTokens,
  sequenceCounts,
  type HubspotClient,
  type HubspotConfig,
  type Sequence,
  type Tokens,
} from "./client.ts";

export const SEQUENCE_OUTCOMES = {
  /** An enrollment counts once it is this old: time enough to reply or book. */
  matureDays: 14,
  /** Metrics are final once the sequence is this old... */
  finalDays: 30,
  /** ...and has at least this many mature enrollments. */
  minEnrolled: 20,
};
export const SEQUENCE_METRICS = ["sequence.reply_rate", "sequence.meeting_rate"] as const;

const DAY = 86_400_000;

export interface HubspotDeps {
  db: MasterMindDb;
  vault: Vault;
  config: HubspotConfig;
  redactorFor: RedactorFor;
  enqueue: (name: "categorize.task", data: object, options?: { id?: string }) => Promise<void>;
  now?: () => Date;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export const refreshTokenPurpose = (connectionId: string) =>
  `hubspot:${connectionId}:refresh_token`;

export const sequenceTaskId = (tenantId: string, connectionId: string, sequenceId: string) =>
  idFromKey([tenantId, "hubspot", "sequence", connectionId, sequenceId]);

/** Seals and stores the refresh token from a just-finished OAuth install. */
export async function storeRefreshToken(
  deps: Pick<HubspotDeps, "db" | "vault">,
  tenantId: string,
  connectionId: string,
  refreshToken: string,
): Promise<void> {
  const sealed = await deps.vault.seal(tenantId, refreshTokenPurpose(connectionId), refreshToken);
  await deps.db.withTenant(tenantId, (tx) =>
    connectionRepo.saveSecret(tx, tenantId, connectionId, "refresh_token", sealed),
  );
}

// Access tokens live 30 minutes; keep them in memory only.
const tokenCache = new Map<string, Tokens>();

async function clientFor(
  deps: HubspotDeps,
  tenantId: string,
  conn: Connection,
): Promise<HubspotClient> {
  const cached = tokenCache.get(conn.id);
  if (cached && cached.expiresAt.getTime() > Date.now()) {
    return hubspotClient(deps.config, cached.accessToken);
  }
  const sealed = await deps.db.withTenant(tenantId, (tx) =>
    connectionRepo.loadSecret(tx, conn.id, "refresh_token"),
  );
  if (!sealed) throw new Error("No HubSpot token stored for this connection; reconnect HubSpot.");
  const refresh = await deps.vault.open(tenantId, refreshTokenPurpose(conn.id), sealed);
  const tokens = await refreshTokens(deps.config, refresh);
  if (tokens.refreshToken !== refresh) {
    await storeRefreshToken(deps, tenantId, conn.id, tokens.refreshToken);
  }
  tokenCache.set(conn.id, tokens);
  return hubspotClient(deps.config, tokens.accessToken);
}

/** Links HubSpot users to members with the same work email, and credits their earlier work. */
async function linkOwners(
  deps: HubspotDeps,
  tenantId: string,
  owners: { userId: number | null; email: string | null }[],
): Promise<number> {
  return deps.db.withTenant(tenantId, async (tx) => {
    let linked = 0;
    for (const o of owners) {
      if (!o.userId || !o.email) continue;
      const taken = await tx
        .select({ id: members.id })
        .from(members)
        .where(eq(members.hubspotUserId, o.userId));
      if (taken.length) continue;
      const updated = await tx
        .update(members)
        .set({ hubspotUserId: o.userId })
        .where(and(sql`lower(${members.email}) = lower(${o.email})`, isNull(members.hubspotUserId)))
        .returning({ id: members.id });
      if (!updated[0]) continue;
      linked++;
      await tx
        .update(tasks)
        .set({ memberId: updated[0].id, updatedAt: new Date() })
        .where(and(eq(tasks.actorKey, `hubspot:${o.userId}`), isNull(tasks.memberId)));
    }
    return linked;
  });
}

export type SequenceSyncResult =
  { status: "skipped_opt_out" } | { status: "stored"; taskId: string; created: boolean };

export async function upsertSequence(
  deps: Pick<HubspotDeps, "db" | "redactorFor">,
  ctx: { tenantId: string; connectionId: string },
  seq: Sequence,
): Promise<SequenceSyncResult> {
  const taskId = sequenceTaskId(ctx.tenantId, ctx.connectionId, seq.id);
  const r = await deps.redactorFor(ctx.tenantId);
  const title = await r.redact(seq.name.slice(0, 300));
  const summary = `HubSpot sequence with ${seq.steps} steps (${seq.emailSteps} emails, ${seq.taskSteps} tasks).`;
  const actorKey = `hubspot:${seq.userId}`;
  const features = {
    steps: seq.steps,
    email_steps: seq.emailSteps,
    task_steps: seq.taskSteps,
    labels: ["sequence"],
  };
  const ref = `hubspot:sequence:${seq.id}`;

  return deps.db.withTenant(ctx.tenantId, async (tx) => {
    const [member] = await tx
      .select({ id: members.id, optOut: members.captureOptOut })
      .from(members)
      .where(eq(members.hubspotUserId, seq.userId));
    if (member?.optOut) return { status: "skipped_opt_out" as const };
    const [existing] = await tx
      .select({ taskId: hubspotSequences.taskId })
      .from(hubspotSequences)
      .where(eq(hubspotSequences.taskId, taskId));

    const values = {
      titleRedacted: title.text || "(unnamed sequence)",
      summaryRedacted: summary,
      features,
      redactionCounts: title.counts,
      startedAt: seq.createdAt,
      // The work (writing the sequence) is done when it's created; outcomes come later.
      completedAt: seq.createdAt,
      updatedAt: new Date(),
    };
    await tx
      .insert(tasks)
      .values({
        id: taskId,
        tenantId: ctx.tenantId,
        memberId: member?.id ?? null,
        actorKey,
        connectionId: ctx.connectionId,
        source: "hubspot",
        ...values,
      })
      .onConflictDoUpdate({ target: tasks.id, set: values });
    const row = {
      connectionId: ctx.connectionId,
      sequenceId: seq.id,
      ownerUserId: seq.userId,
      steps: seq.steps,
      emailSteps: seq.emailSteps,
      taskSteps: seq.taskSteps,
      createdAtHs: seq.createdAt,
      updatedAtHs: seq.updatedAt,
      syncedAt: new Date(),
    };
    await tx
      .insert(hubspotSequences)
      .values({ tenantId: ctx.tenantId, taskId, ...row })
      .onConflictDoUpdate({
        target: [hubspotSequences.tenantId, hubspotSequences.taskId],
        set: row,
      });
    await tx
      .insert(externalRefs)
      .values({ tenantId: ctx.tenantId, taskId, ref })
      .onConflictDoNothing();
    if (!existing) {
      await enqueueLakeRecords(tx, ctx.tenantId, [
        taskRecord({
          id: taskId,
          tenantId: ctx.tenantId,
          memberId: member?.id ?? null,
          actorKey,
          agentId: null,
          source: "hubspot",
          sessionId: null,
          private: false,
          title: values.titleRedacted,
          summary,
          categoryHint: null,
          externalRefs: [ref],
          features,
          startedAt: seq.createdAt,
          completedAt: seq.createdAt,
          createdAt: seq.createdAt,
          ingestedAt: new Date(),
        }),
      ]);
    }
    return { status: "stored" as const, taskId, created: !existing };
  });
}

/** Imports owners and sequences for every active HubSpot connection of a tenant. */
export async function syncHubspot(deps: HubspotDeps, tenantId: string): Promise<number> {
  const conns = await deps.db.withTenant(tenantId, (tx) =>
    connectionRepo.listConnections(tx, "hubspot"),
  );
  let stored = 0;
  for (const conn of conns.filter((c) => c.status === "active")) {
    try {
      const client = await clientFor(deps, tenantId, conn);
      const owners = await listOwners(client);
      await linkOwners(deps, tenantId, owners);
      const users = [...new Set(owners.map((o) => o.userId).filter((u): u is number => !!u))];
      for (const userId of users) {
        for (const seq of await listSequences(client, userId)) {
          const out = await upsertSequence(deps, { tenantId, connectionId: conn.id }, seq);
          if (out.status !== "stored") continue;
          stored++;
          if (out.created) {
            await deps.enqueue(
              "categorize.task",
              { tenantId, taskId: out.taskId },
              { id: idFromKey([out.taskId, "categorize", "hubspot"]) },
            );
          }
        }
      }
      if (conn.backfillStatus !== "done") {
        await deps.db.withTenant(tenantId, async (tx) => {
          await connectionRepo.updateBackfill(tx, conn.id, {
            backfillStatus: "done",
            backfillError: null,
          });
          await appendAuditEvent(tx, tenantId, {
            actorType: "system",
            actorId: null,
            action: "connection.backfill_done",
            targetType: "connection",
            targetId: conn.id,
            payload: { provider: "hubspot" },
          });
        });
      }
    } catch (err) {
      if (err instanceof HubspotRateLimitedError) {
        deps.log?.("hubspot.rate_limited", { tenantId, retryAt: err.retryAt.toISOString() });
        continue;
      }
      await deps.db.withTenant(tenantId, (tx) =>
        connectionRepo.updateBackfill(tx, conn.id, {
          backfillStatus: conn.backfillStatus === "done" ? "done" : "failed",
          backfillError: (err as Error).message.slice(0, 2000),
        }),
      );
      deps.log?.("hubspot.sync_failed", { tenantId, connectionId: conn.id });
    }
  }
  return stored;
}

/** Writes final outcome metrics for sequences that are old enough. Returns how many. */
export async function finalizeSequenceOutcomes(
  deps: HubspotDeps,
  tenantId: string,
  limit = 50,
): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const due = await deps.db.withTenant(tenantId, (tx) =>
    tx.execute<{
      task_id: string;
      sequence_id: string;
      connection_id: string;
      member_id: string | null;
      actor_key: string | null;
    }>(sql`
      SELECT s.task_id, s.sequence_id, s.connection_id, t.member_id, t.actor_key
        FROM hubspot_sequences s
        JOIN tasks t ON t.tenant_id = s.tenant_id AND t.id = s.task_id
        JOIN connections c ON c.tenant_id = s.tenant_id AND c.id = s.connection_id
       WHERE s.metrics_final_at IS NULL AND c.status = 'active'
         AND s.created_at_hs <= ${new Date(now.getTime() - SEQUENCE_OUTCOMES.finalDays * DAY).toISOString()}
         AND s.created_at_hs > ${new Date(now.getTime() - 365 * DAY).toISOString()}
       ORDER BY s.synced_at
       LIMIT ${limit}`),
  );
  const conns = new Map<string, Connection>();
  let finalized = 0;
  for (const s of due.rows) {
    let conn = conns.get(s.connection_id);
    if (!conn) {
      conn =
        (await deps.db.withTenant(tenantId, (tx) =>
          connectionRepo.getConnection(tx, s.connection_id),
        )) ?? undefined;
      if (!conn) continue;
      conns.set(conn.id, conn);
    }
    let counts;
    try {
      const client = await clientFor(deps, tenantId, conn);
      counts = await sequenceCounts(
        client,
        s.sequence_id,
        new Date(now.getTime() - SEQUENCE_OUTCOMES.matureDays * DAY),
      );
    } catch (err) {
      if (err instanceof HubspotRateLimitedError) break;
      throw err;
    }
    const final = counts.enrolled >= SEQUENCE_OUTCOMES.minEnrolled;
    await deps.db.withTenant(tenantId, async (tx) => {
      await tx
        .update(hubspotSequences)
        .set({
          counts: { ...counts, as_of: now.toISOString() },
          syncedAt: now,
          ...(final ? { metricsFinalAt: now } : {}),
        })
        .where(eq(hubspotSequences.taskId, s.task_id));
      if (!final) return;
      const values = {
        "sequence.reply_rate": counts.replied / counts.enrolled,
        "sequence.meeting_rate": counts.meetings / counts.enrolled,
      };
      const records = [];
      for (const [metric, raw] of Object.entries(values)) {
        const value = Math.round(raw * 10_000) / 10_000;
        const id = idFromKey([s.task_id, metric, "final"]);
        await tx
          .insert(metricObservations)
          .values({
            id,
            tenantId,
            taskId: s.task_id,
            metricKey: metric,
            value,
            n: counts.enrolled,
            source: "hubspot",
            observedAt: now,
          })
          .onConflictDoNothing();
        records.push(
          metricRecord({
            id,
            tenantId,
            memberId: s.member_id,
            actorKey: s.actor_key,
            agentId: null,
            source: "hubspot",
            taskId: s.task_id,
            metric,
            value,
            n: counts.enrolled,
            note: null,
            observedAt: now,
            ingestedAt: now,
          }),
        );
      }
      await enqueueLakeRecords(tx, tenantId, records);
      finalized++;
    });
  }
  if (finalized) deps.log?.("hubspot.outcomes_final", { tenantId, sequences: finalized });
  return finalized;
}
