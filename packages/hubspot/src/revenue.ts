// The rest of the revenue pack: marketing emails and deals, each one task (source "hubspot")
// credited to the HubSpot user behind it.
//
// Emails: aggregate counts only. Metrics (click, open and unsubscribe rates over delivered)
// are written once the email is a week old and reached enough people.
// Deals: stage and outcome only, never amounts. Metrics (won, days to close) are written once
// the deal closes; open deals are tasks without a completion date, so they aren't judged.
import {
  eq,
  externalRefs,
  hubspotDeals,
  hubspotMarketingEmails,
  idFromKey,
  members,
  metricObservations,
  tasks,
  type CaptureSource,
  type MasterMindDb,
  type TenantTx,
} from "@mm/db";
import type { RedactorFor } from "@mm/ingest";
import { enqueueLakeRecords, metricRecord, taskRecord } from "@mm/lake";
import {
  listDeals,
  listMarketingEmails,
  type Deal,
  type HubspotClient,
  type MarketingEmail,
  type Owner,
} from "./client.ts";

export const EMAIL_OUTCOMES = {
  /** Opens and clicks mostly arrive in the first days; metrics are final after a week. */
  finalDays: 7,
  /** Rates over fewer deliveries than this say little. */
  minDelivered: 50,
};
export const EMAIL_METRICS = ["email.open_rate", "email.click_rate", "email.unsubscribe_rate"];
export const DEAL_METRICS = ["deal.won", "deal.days_to_close"];

const DAY = 86_400_000;

export interface RevenueDeps {
  db: MasterMindDb;
  redactorFor: RedactorFor;
  now?: () => Date;
}

interface ConnectorTask {
  taskId: string;
  ref: string;
  /** HubSpot user id credited with the work. */
  userId: number | null;
  title: string;
  summary: string;
  features: Record<string, unknown>;
  startedAt: Date;
  completedAt: Date | null;
}

type Upserted =
  { status: "skipped_opt_out" } | { status: "stored"; created: boolean; memberId: string | null };

/** Writes (or refreshes) one connector task with its ref, and its lake row the first time. */
async function upsertTask(
  tx: TenantTx,
  ctx: { tenantId: string; connectionId: string },
  t: ConnectorTask,
): Promise<Upserted> {
  const actorKey = t.userId ? `hubspot:${t.userId}` : `hubspot:portal`;
  const [member] = t.userId
    ? await tx
        .select({ id: members.id, optOut: members.captureOptOut })
        .from(members)
        .where(eq(members.hubspotUserId, t.userId))
    : [];
  if (member?.optOut) return { status: "skipped_opt_out" };
  const [existing] = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, t.taskId));
  const values = {
    titleRedacted: t.title,
    summaryRedacted: t.summary,
    features: t.features,
    startedAt: t.startedAt,
    completedAt: t.completedAt,
    updatedAt: new Date(),
  };
  await tx
    .insert(tasks)
    .values({
      id: t.taskId,
      tenantId: ctx.tenantId,
      memberId: member?.id ?? null,
      actorKey,
      connectionId: ctx.connectionId,
      source: "hubspot",
      ...values,
    })
    .onConflictDoUpdate({ target: tasks.id, set: values });
  await tx
    .insert(externalRefs)
    .values({ tenantId: ctx.tenantId, taskId: t.taskId, ref: t.ref })
    .onConflictDoNothing();
  if (!existing) {
    await enqueueLakeRecords(tx, ctx.tenantId, [
      taskRecord({
        id: t.taskId,
        tenantId: ctx.tenantId,
        memberId: member?.id ?? null,
        actorKey,
        agentId: null,
        source: "hubspot",
        sessionId: null,
        private: false,
        title: t.title,
        summary: t.summary,
        categoryHint: null,
        externalRefs: [t.ref],
        features: t.features,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
        createdAt: t.startedAt,
        ingestedAt: new Date(),
      }),
    ]);
  }
  return { status: "stored", created: !existing, memberId: member?.id ?? null };
}

/** Writes final metrics once (ids are derived, so a retry adds nothing). */
async function writeMetrics(
  tx: TenantTx,
  tenantId: string,
  task: { taskId: string; memberId: string | null; actorKey: string },
  values: Record<string, number>,
  n: number,
  observedAt: Date,
) {
  const records = [];
  for (const [metric, raw] of Object.entries(values)) {
    const value = Math.round(raw * 10_000) / 10_000;
    const id = idFromKey([task.taskId, metric, "final"]);
    const inserted = await tx
      .insert(metricObservations)
      .values({
        id,
        tenantId,
        taskId: task.taskId,
        metricKey: metric,
        value,
        n,
        source: "hubspot" as CaptureSource,
        observedAt,
      })
      .onConflictDoNothing()
      .returning({ id: metricObservations.id });
    if (!inserted.length) continue;
    records.push(
      metricRecord({
        id,
        tenantId,
        memberId: task.memberId,
        actorKey: task.actorKey,
        agentId: null,
        source: "hubspot",
        taskId: task.taskId,
        metric,
        value,
        n,
        note: null,
        observedAt,
        ingestedAt: new Date(),
      }),
    );
  }
  if (records.length) await enqueueLakeRecords(tx, tenantId, records);
}

export const emailTaskId = (tenantId: string, connectionId: string, emailId: string) =>
  idFromKey([tenantId, "hubspot", "email", connectionId, emailId]);
export const dealTaskId = (tenantId: string, connectionId: string, dealId: string) =>
  idFromKey([tenantId, "hubspot", "deal", connectionId, dealId]);

export type RevenueSyncResult = { stored: number; created: string[]; finalized: number };

export async function upsertMarketingEmail(
  deps: RevenueDeps,
  ctx: { tenantId: string; connectionId: string },
  e: MarketingEmail,
): Promise<{ taskId: string; created: boolean; finalized: boolean } | null> {
  const now = deps.now?.() ?? new Date();
  const taskId = emailTaskId(ctx.tenantId, ctx.connectionId, e.id);
  const r = await deps.redactorFor(ctx.tenantId);
  const title = (await r.redact(e.name.slice(0, 300))).text || "(unnamed email)";
  const features = {
    labels: ["marketing_email"],
    email_type: e.type,
    ab_test: e.abTest,
  };
  return deps.db.withTenant(ctx.tenantId, async (tx) => {
    const out = await upsertTask(tx, ctx, {
      taskId,
      ref: `hubspot:email:${e.id}`,
      userId: e.userId,
      title,
      summary: `HubSpot marketing email${e.type ? ` (${e.type.toLowerCase()})` : ""}.`,
      features,
      startedAt: e.publishedAt,
      completedAt: e.publishedAt,
    });
    if (out.status !== "stored") return null;
    const [row] = await tx
      .select({ final: hubspotMarketingEmails.metricsFinalAt })
      .from(hubspotMarketingEmails)
      .where(eq(hubspotMarketingEmails.taskId, taskId));
    const due =
      !row?.final &&
      e.publishedAt.getTime() <= now.getTime() - EMAIL_OUTCOMES.finalDays * DAY &&
      e.stats.delivered >= EMAIL_OUTCOMES.minDelivered;
    const counts = { ...e.stats, as_of: now.toISOString() };
    const fields = {
      connectionId: ctx.connectionId,
      emailId: e.id,
      ownerUserId: e.userId,
      publishedAt: e.publishedAt,
      counts,
      syncedAt: now,
      ...(due ? { metricsFinalAt: now } : {}),
    };
    await tx
      .insert(hubspotMarketingEmails)
      .values({ tenantId: ctx.tenantId, taskId, ...fields })
      .onConflictDoUpdate({
        target: [hubspotMarketingEmails.tenantId, hubspotMarketingEmails.taskId],
        set: row?.final ? { counts, syncedAt: now } : fields,
      });
    if (due) {
      const d = e.stats.delivered;
      await writeMetrics(
        tx,
        ctx.tenantId,
        {
          taskId,
          memberId: out.memberId,
          actorKey: e.userId ? `hubspot:${e.userId}` : "hubspot:portal",
        },
        {
          "email.open_rate": Math.min(1, e.stats.opened / d),
          "email.click_rate": Math.min(1, e.stats.clicked / d),
          "email.unsubscribe_rate": Math.min(1, e.stats.unsubscribed / d),
        },
        d,
        now,
      );
    }
    return { taskId, created: out.created, finalized: due };
  });
}

export async function upsertDeal(
  deps: RevenueDeps,
  ctx: { tenantId: string; connectionId: string },
  d: Deal,
  ownerUserId: number | null,
): Promise<{ taskId: string; created: boolean; finalized: boolean } | null> {
  const now = deps.now?.() ?? new Date();
  const taskId = dealTaskId(ctx.tenantId, ctx.connectionId, d.id);
  const r = await deps.redactorFor(ctx.tenantId);
  // Deal names often carry the customer's name; the redactor handles people, not companies,
  // so the name is kept as written after redaction. Amounts are never requested.
  const title = (await r.redact(d.name.slice(0, 300))).text || "(unnamed deal)";
  const type = d.dealType?.toLowerCase().replace(/[^a-z0-9]+/g, "") ?? null;
  const features = {
    labels: ["deal", ...(type ? [`deal_type_${type}`] : [])],
    pipeline: d.pipeline,
  };
  return deps.db.withTenant(ctx.tenantId, async (tx) => {
    const out = await upsertTask(tx, ctx, {
      taskId,
      ref: `hubspot:deal:${d.id}`,
      userId: ownerUserId,
      title,
      summary: `HubSpot deal${d.dealType ? ` (${d.dealType})` : ""}.`,
      features,
      startedAt: d.createdAt,
      // The work is done when the deal closes; open deals aren't judged yet.
      completedAt: d.closedAt,
    });
    if (out.status !== "stored") return null;
    const [row] = await tx
      .select({ final: hubspotDeals.metricsFinalAt })
      .from(hubspotDeals)
      .where(eq(hubspotDeals.taskId, taskId));
    const due = !row?.final && d.isClosed && d.closedAt !== null;
    const fields = {
      connectionId: ctx.connectionId,
      dealId: d.id,
      ownerUserId,
      pipeline: d.pipeline?.slice(0, 100) ?? null,
      stage: d.stage?.slice(0, 100) ?? null,
      dealType: d.dealType?.slice(0, 100) ?? null,
      createdAtHs: d.createdAt,
      closedAt: d.closedAt,
      isClosed: d.isClosed,
      isWon: d.isWon,
      syncedAt: now,
      ...(due ? { metricsFinalAt: now } : {}),
    };
    await tx
      .insert(hubspotDeals)
      .values({ tenantId: ctx.tenantId, taskId, ...fields })
      .onConflictDoUpdate({ target: [hubspotDeals.tenantId, hubspotDeals.taskId], set: fields });
    if (due) {
      await writeMetrics(
        tx,
        ctx.tenantId,
        {
          taskId,
          memberId: out.memberId,
          actorKey: ownerUserId ? `hubspot:${ownerUserId}` : "hubspot:portal",
        },
        {
          "deal.won": d.isWon ? 1 : 0,
          "deal.days_to_close": Math.max(0, (d.closedAt!.getTime() - d.createdAt.getTime()) / DAY),
        },
        1,
        d.closedAt!,
      );
    }
    return { taskId, created: out.created, finalized: due };
  });
}

/** Imports marketing emails and deals for one connection. */
export async function syncRevenue(
  deps: RevenueDeps,
  ctx: { tenantId: string; connectionId: string },
  client: HubspotClient,
  owners: Owner[],
): Promise<RevenueSyncResult> {
  const result: RevenueSyncResult = { stored: 0, created: [], finalized: 0 };
  const now = deps.now?.() ?? new Date();
  const record = (r: { taskId: string; created: boolean; finalized: boolean } | null) => {
    if (!r) return;
    result.stored++;
    if (r.created) result.created.push(r.taskId);
    if (r.finalized) result.finalized++;
  };
  // A year of history: enough for baselines and the backtest.
  const since = new Date(now.getTime() - 365 * DAY);
  for (const e of await listMarketingEmails(client, { publishedAfter: since })) {
    record(await upsertMarketingEmail(deps, ctx, e));
  }
  const userOf = new Map(owners.map((o) => [o.id, o.userId]));
  for (const d of await listDeals(client)) {
    if (d.createdAt < since && !d.closedAt) continue;
    if (d.closedAt && d.closedAt < since) continue;
    record(await upsertDeal(deps, ctx, d, d.ownerId ? (userOf.get(d.ownerId) ?? null) : null));
  }
  return result;
}
