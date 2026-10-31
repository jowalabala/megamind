// Collaboration channels: two agents coordinate directly, but only after every human whose
// agent takes part has said yes (on the web, or ahead of time with a pre-approval rule).
// Agents can request, send, claim, agree and close; they can never approve.
//
// Every function runs in the caller's tenant transaction. Text from agents arrives raw and is
// redacted here (deterministic layers) before it's stored; anything that reads like
// instructions aimed at the other agent is blocked.
import { appendAuditEvent } from "@mm/audit";
import {
  agentSessions,
  agreements,
  and,
  channelMessages,
  channelParticipants,
  channels,
  collabPreapprovals,
  collabSettings,
  eq,
  idFromKey,
  inArray,
  isNull,
  leases,
  members,
  sql,
  SHARE_KINDS,
  type ChannelMessageType,
  type ChannelScope,
  type ShareKind,
  type TenantTx,
} from "@mm/db";
import { channelMessageRecord, enqueueLakeRecords } from "@mm/lake";
import { detectInjection, type Redactor } from "@mm/privacy";

export const CHANNEL_NOTIFY = "mm_channels";
export const MAX_MESSAGE_CHARS = 8000;
export const MAX_MESSAGES_PER_MINUTE = 30;
export const DEFAULT_LEASE_MINUTES = 60;

export type CollabErrorCode =
  "forbidden" | "not_found" | "conflict" | "policy" | "blocked" | "closed";

export class CollabError extends Error {
  override name = "CollabError";
  constructor(
    readonly code: CollabErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const notify = (tx: TenantTx, tenantId: string) =>
  tx.execute(sql`SELECT pg_notify(${CHANNEL_NOTIFY}, ${tenantId})`);

export async function getSettings(tx: TenantTx, tenantId: string) {
  const [row] = await tx.select().from(collabSettings).where(eq(collabSettings.tenantId, tenantId));
  return (
    row ?? {
      tenantId,
      enabled: true,
      crossTeamAllowed: false,
      maxTtlMinutes: 480,
      allowedShare: ["intents", "summaries", "messages"] as ShareKind[],
      updatedAt: new Date(0),
    }
  );
}

async function sharesTeam(tx: TenantTx, a: string, b: string): Promise<boolean> {
  const res = await tx.execute<{ shares: boolean }>(sql`
    SELECT (EXISTS (SELECT 1 FROM team_members x JOIN team_members y ON x.team_id = y.team_id
                     WHERE x.member_id = ${a} AND y.member_id = ${b})
            OR (NOT EXISTS (SELECT 1 FROM team_members WHERE member_id = ${a})
                AND NOT EXISTS (SELECT 1 FROM team_members WHERE member_id = ${b}))) AS shares`);
  return Boolean(res.rows[0]?.shares);
}

async function liveSession(tx: TenantTx, id: string) {
  const [s] = await tx
    .select({
      id: agentSessions.id,
      memberId: agentSessions.memberId,
      agentId: agentSessions.agentIdentityId,
      private: agentSessions.private,
      status: agentSessions.status,
      context: agentSessions.contextRedacted,
      optOut: members.captureOptOut,
    })
    .from(agentSessions)
    .innerJoin(members, eq(members.id, agentSessions.memberId))
    .where(eq(agentSessions.id, id));
  return s ?? null;
}

// --- Request and approve ---------------------------------------------------------------------

export interface RequestInput {
  fromSessionId: string;
  toSessionId: string;
  purpose: string;
  resources: string[];
  share: ShareKind[];
  ttlMinutes: number;
}

export async function requestChannel(
  tx: TenantTx,
  tenantId: string,
  redactor: Redactor,
  input: RequestInput,
) {
  const settings = await getSettings(tx, tenantId);
  if (!settings.enabled)
    throw new CollabError("policy", "Channels are turned off in this workspace.");
  const from = await liveSession(tx, input.fromSessionId);
  const to = await liveSession(tx, input.toSessionId);
  if (!from || from.status !== "active")
    throw new CollabError("not_found", "Your session isn't active.");
  // A private or opted-out session is invisible, so it can't be asked either.
  if (!to || to.status !== "active" || to.private || to.optOut) {
    throw new CollabError("not_found", "That session isn't available.");
  }
  if (from.memberId === to.memberId)
    throw new CollabError("policy", "Both sessions belong to the same person.");
  if (!settings.crossTeamAllowed && !(await sharesTeam(tx, from.memberId, to.memberId))) {
    throw new CollabError("policy", "Channels across teams are turned off in this workspace.");
  }
  const share = [...new Set(input.share)];
  const notAllowed = share.filter((s) => !settings.allowedShare.includes(s));
  if (notAllowed.length)
    throw new CollabError("policy", `Sharing ${notAllowed.join(", ")} isn't allowed here.`);
  if (input.ttlMinutes > settings.maxTtlMinutes) {
    throw new CollabError(
      "policy",
      `Channels can last at most ${settings.maxTtlMinutes} minutes here.`,
    );
  }

  const purpose = redactor.redactSync(input.purpose).text.slice(0, 1000);
  const resources = input.resources.map((r) => redactor.redactSync(r).text).slice(0, 50);
  const scope: ChannelScope = { resources, share, ttl_minutes: input.ttlMinutes };
  const id = crypto.randomUUID();
  await tx
    .insert(channels)
    .values({ id, tenantId, purposeRedacted: purpose, scope, requestedBy: from.id });

  // Each human approves for their own agent, now or ahead of time.
  for (const s of [from, to]) {
    const rules = await tx
      .select()
      .from(collabPreapprovals)
      .where(eq(collabPreapprovals.memberId, s.memberId));
    const other = s === from ? to : from;
    let pre = false;
    for (const r of rules) {
      if (r.sameTeamOnly && !(await sharesTeam(tx, s.memberId, other.memberId))) continue;
      if (r.repo && r.repo !== (s.context?.repo as string | undefined)) continue;
      if (!share.every((x) => r.share.includes(x))) continue;
      pre = true;
      break;
    }
    await tx.insert(channelParticipants).values({
      tenantId,
      channelId: id,
      sessionId: s.id,
      memberId: s.memberId,
      approval: pre ? "approved" : "pending",
      approvedVia: pre ? "preapproval" : null,
      decidedAt: pre ? new Date() : null,
    });
  }
  await appendAuditEvent(tx, tenantId, {
    actorType: "agent",
    actorId: from.agentId,
    action: "channel.requested",
    targetType: "channel",
    targetId: id,
    payload: {
      with_member: to.memberId,
      share,
      ttl_minutes: input.ttlMinutes,
      resources: resources.length,
    },
  });
  const status = await maybeOpen(tx, tenantId, id);
  await notify(tx, tenantId);
  return { id, status, scope };
}

async function maybeOpen(tx: TenantTx, tenantId: string, channelId: string) {
  const parts = await tx
    .select()
    .from(channelParticipants)
    .where(eq(channelParticipants.channelId, channelId));
  const [ch] = await tx.select().from(channels).where(eq(channels.id, channelId));
  if (!ch || ch.status !== "requested") return ch?.status ?? "closed";
  if (parts.some((p) => p.approval === "declined")) {
    await tx
      .update(channels)
      .set({ status: "rejected", closedAt: new Date(), closeReason: "declined" })
      .where(eq(channels.id, channelId));
    await appendAuditEvent(tx, tenantId, {
      actorType: "system",
      actorId: null,
      action: "channel.rejected",
      targetType: "channel",
      targetId: channelId,
    });
    return "rejected" as const;
  }
  if (parts.every((p) => p.approval === "approved")) {
    const now = new Date();
    await tx
      .update(channels)
      .set({
        status: "open",
        openedAt: now,
        closesAt: new Date(now.getTime() + ch.scope.ttl_minutes * 60_000),
      })
      .where(eq(channels.id, channelId));
    await appendAuditEvent(tx, tenantId, {
      actorType: "system",
      actorId: null,
      action: "channel.opened",
      targetType: "channel",
      targetId: channelId,
    });
    return "open" as const;
  }
  return "requested" as const;
}

/**
 * A human's decision for their own agent's part in a channel. Called only from the web app
 * with a signed-in member; there is no agent-facing way to reach it.
 */
export async function decide(
  tx: TenantTx,
  tenantId: string,
  input: {
    channelId: string;
    memberId: string;
    decision: "approve" | "decline";
    via?: "web" | "slack";
  },
) {
  const mine = await tx
    .select()
    .from(channelParticipants)
    .where(
      and(
        eq(channelParticipants.channelId, input.channelId),
        eq(channelParticipants.memberId, input.memberId),
      ),
    );
  if (mine.length === 0) throw new CollabError("forbidden", "You're not part of this channel.");
  const [ch] = await tx.select().from(channels).where(eq(channels.id, input.channelId));
  if (!ch || ch.status !== "requested")
    throw new CollabError("closed", "This request is no longer open.");
  await tx
    .update(channelParticipants)
    .set({
      approval: input.decision === "approve" ? "approved" : "declined",
      approvedVia: input.via ?? "web",
      decidedAt: new Date(),
    })
    .where(
      and(
        eq(channelParticipants.channelId, input.channelId),
        eq(channelParticipants.memberId, input.memberId),
      ),
    );
  await appendAuditEvent(tx, tenantId, {
    actorType: "member",
    actorId: input.memberId,
    action: input.decision === "approve" ? "channel.approved" : "channel.declined",
    targetType: "channel",
    targetId: input.channelId,
    payload: { via: input.via ?? "web" },
  });
  const status = await maybeOpen(tx, tenantId, input.channelId);
  await notify(tx, tenantId);
  return status;
}

// --- Messages ---------------------------------------------------------------------------------

async function openChannelFor(tx: TenantTx, channelId: string, sessionId: string) {
  const [ch] = await tx.select().from(channels).where(eq(channels.id, channelId));
  if (!ch) throw new CollabError("not_found", "No such channel.");
  const [me] = await tx
    .select()
    .from(channelParticipants)
    .where(
      and(
        eq(channelParticipants.channelId, channelId),
        eq(channelParticipants.sessionId, sessionId),
      ),
    );
  if (!me) throw new CollabError("forbidden", "Your session isn't in this channel.");
  if (ch.status !== "open" || (ch.closesAt && ch.closesAt < new Date())) {
    throw new CollabError(
      "closed",
      `The channel is ${ch.status === "open" ? "past its time limit" : ch.status}.`,
    );
  }
  return { ch, me };
}

/** Which share permission each message type needs. */
const NEEDS: Record<ChannelMessageType, ShareKind> = {
  intent_update: "intents",
  proposal: "messages",
  interface_change: "messages",
  question: "messages",
  answer: "messages",
  handoff: "summaries",
  claim: "intents",
  release: "intents",
  note: "messages",
};

async function store(
  tx: TenantTx,
  tenantId: string,
  channelId: string,
  fromSession: { id: string; memberId: string; agentId: string | null },
  type: ChannelMessageType,
  body: string,
  scan: Record<string, unknown>,
) {
  const [{ seq }] = (await tx
    .update(channels)
    .set({ lastSeq: sql`${channels.lastSeq} + 1` })
    .where(eq(channels.id, channelId))
    .returning({ seq: channels.lastSeq })) as [{ seq: number }];
  const id = idFromKey([tenantId, "channel_message", channelId, String(seq)]);
  const now = new Date();
  await tx.insert(channelMessages).values({
    tenantId,
    channelId,
    seq,
    id,
    fromSession: fromSession.id,
    type,
    bodyRedacted: body,
    scan,
  });
  // The transcript goes to the lake as it happens.
  await enqueueLakeRecords(tx, tenantId, [
    channelMessageRecord({
      id,
      tenantId,
      memberId: fromSession.memberId,
      agentId: fromSession.agentId,
      source: "mcp",
      channelId,
      seq,
      sessionId: fromSession.id,
      type,
      body,
      sentAt: now,
      ingestedAt: now,
    }),
  ]);
  await notify(tx, tenantId);
  return { seq, id };
}

export async function send(
  tx: TenantTx,
  tenantId: string,
  redactor: Redactor,
  input: { channelId: string; sessionId: string; type: ChannelMessageType; body: string },
) {
  const { ch, me } = await openChannelFor(tx, input.channelId, input.sessionId);
  if (!ch.scope.share.includes(NEEDS[input.type])) {
    throw new CollabError("policy", `This channel doesn't allow sharing ${NEEDS[input.type]}.`);
  }
  if (input.body.length > MAX_MESSAGE_CHARS)
    throw new CollabError("policy", `Messages are limited to ${MAX_MESSAGE_CHARS} characters.`);
  const recent = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM channel_messages
     WHERE channel_id = ${input.channelId} AND from_session = ${input.sessionId}
       AND created_at > now() - interval '1 minute'`);
  if (recent.rows[0]!.n >= MAX_MESSAGES_PER_MINUTE)
    throw new CollabError("policy", "Too many messages; slow down.");

  const injection = detectInjection(input.body);
  if (injection.length) {
    await appendAuditEvent(tx, tenantId, {
      actorType: "system",
      actorId: null,
      action: "channel.message_blocked",
      targetType: "channel",
      targetId: input.channelId,
      payload: { from_session: input.sessionId, reason: "injection" },
    });
    // Returned, not thrown, so the audit record above commits.
    return { status: "blocked" as const, injection };
  }
  const r = redactor.redactSync(input.body);
  const [s] = await tx
    .select({ agentId: agentSessions.agentIdentityId })
    .from(agentSessions)
    .where(eq(agentSessions.id, me.sessionId));
  const stored = await store(
    tx,
    tenantId,
    input.channelId,
    { id: me.sessionId, memberId: me.memberId, agentId: s?.agentId ?? null },
    input.type,
    r.text,
    {
      redactions: Object.values(r.counts).reduce((a, b) => a + b, 0),
    },
  );
  return { status: "sent" as const, ...stored };
}

// --- Leases -----------------------------------------------------------------------------------

/** Inside the channel's scope: equal to a scoped resource or under it (paths, prefixes). */
function inScope(scope: ChannelScope, resource: string) {
  return (
    scope.resources.length === 0 ||
    scope.resources.some((r) => resource === r || resource.startsWith(r.replace(/\*+$/, "")))
  );
}

export async function claim(
  tx: TenantTx,
  tenantId: string,
  input: { channelId: string; sessionId: string; resource: string; minutes?: number },
) {
  const { ch, me } = await openChannelFor(tx, input.channelId, input.sessionId);
  if (!inScope(ch.scope, input.resource))
    throw new CollabError("policy", "That resource is outside this channel's scope.");
  // Serialize claims on the same resource across the tenant.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId} || '|' || ${input.resource}))`,
  );
  const [held] = await tx
    .select()
    .from(leases)
    .where(
      and(
        eq(leases.resource, input.resource),
        isNull(leases.releasedAt),
        sql`${leases.expiresAt} > now()`,
      ),
    );
  const minutes = Math.min(input.minutes ?? DEFAULT_LEASE_MINUTES, ch.scope.ttl_minutes);
  const expiresAt = new Date(
    Math.min(Date.now() + minutes * 60_000, ch.closesAt?.getTime() ?? Infinity),
  );
  if (held && held.holderSession !== me.sessionId) {
    throw new CollabError("conflict", "Someone else holds that resource.", {
      expires_at: held.expiresAt.toISOString(),
      fencing_token: held.fencingToken,
    });
  }
  if (held) {
    await tx.update(leases).set({ expiresAt }).where(eq(leases.id, held.id));
    return { fencingToken: held.fencingToken, expiresAt };
  }
  const [lease] = await tx
    .insert(leases)
    .values({
      tenantId,
      resource: input.resource,
      holderSession: me.sessionId,
      channelId: ch.id,
      expiresAt,
    })
    .returning();
  await store(
    tx,
    tenantId,
    ch.id,
    { id: me.sessionId, memberId: me.memberId, agentId: null },
    "claim",
    `Claimed ${input.resource} until ${expiresAt.toISOString()} (token ${lease!.fencingToken}).`,
    {},
  );
  return { fencingToken: lease!.fencingToken, expiresAt };
}

export async function release(
  tx: TenantTx,
  tenantId: string,
  input: { channelId: string; sessionId: string; resource: string; fencingToken: number },
) {
  const { me } = await openChannelFor(tx, input.channelId, input.sessionId);
  const out = await tx
    .update(leases)
    .set({ releasedAt: new Date() })
    .where(
      and(
        eq(leases.resource, input.resource),
        eq(leases.holderSession, me.sessionId),
        eq(leases.fencingToken, input.fencingToken),
        isNull(leases.releasedAt),
      ),
    )
    .returning({ id: leases.id });
  // A stale token (the lease expired and someone else took it) releases nothing.
  if (out.length === 0) throw new CollabError("conflict", "No current lease with that token.");
  await store(
    tx,
    tenantId,
    input.channelId,
    { id: me.sessionId, memberId: me.memberId, agentId: null },
    "release",
    `Released ${input.resource}.`,
    {},
  );
  return { released: true };
}

// --- Agreements -------------------------------------------------------------------------------

export async function proposeAgreement(
  tx: TenantTx,
  tenantId: string,
  redactor: Redactor,
  input: { channelId: string; sessionId: string; body: string; expectedVersion: number },
) {
  const { me } = await openChannelFor(tx, input.channelId, input.sessionId);
  if (detectInjection(input.body).length)
    throw new CollabError(
      "blocked",
      "Agreement blocked: it reads like instructions to the other agent.",
    );
  await tx.execute(sql`SELECT 1 FROM channels WHERE id = ${input.channelId} FOR UPDATE`);
  const [cur] = await tx
    .execute<{ v: number | null }>(
      sql`
    SELECT max(version)::int AS v FROM agreements WHERE channel_id = ${input.channelId}`,
    )
    .then((r) => r.rows);
  const current = cur?.v ?? 0;
  if (current !== input.expectedVersion) {
    throw new CollabError("conflict", "The agreement changed since you read it.", {
      current_version: current,
    });
  }
  const body = redactor.redactSync(input.body).text;
  await tx.insert(agreements).values({
    tenantId,
    channelId: input.channelId,
    version: current + 1,
    bodyRedacted: body,
    proposedBy: me.sessionId,
    acceptedBy: [me.sessionId],
  });
  await store(
    tx,
    tenantId,
    input.channelId,
    { id: me.sessionId, memberId: me.memberId, agentId: null },
    "proposal",
    `Proposed agreement v${current + 1}: ${body}`,
    {},
  );
  return { version: current + 1 };
}

export async function acceptAgreement(
  tx: TenantTx,
  tenantId: string,
  input: { channelId: string; sessionId: string; version: number },
) {
  const { me } = await openChannelFor(tx, input.channelId, input.sessionId);
  const [latest] = await tx
    .select()
    .from(agreements)
    .where(eq(agreements.channelId, input.channelId))
    .orderBy(sql`${agreements.version} DESC`)
    .limit(1);
  if (!latest || latest.version !== input.version) {
    throw new CollabError("conflict", "That isn't the latest agreement.", {
      current_version: latest?.version ?? 0,
    });
  }
  const acceptedBy = [...new Set([...latest.acceptedBy, me.sessionId])];
  await tx
    .update(agreements)
    .set({ acceptedBy })
    .where(and(eq(agreements.channelId, input.channelId), eq(agreements.version, input.version)));
  const parts = await tx
    .select({ s: channelParticipants.sessionId })
    .from(channelParticipants)
    .where(eq(channelParticipants.channelId, input.channelId));
  const complete = parts.every((p) => acceptedBy.includes(p.s));
  await store(
    tx,
    tenantId,
    input.channelId,
    { id: me.sessionId, memberId: me.memberId, agentId: null },
    "answer",
    `Accepted agreement v${input.version}.${complete ? " Everyone has accepted." : ""}`,
    {},
  );
  return { version: input.version, complete };
}

// --- Reading, closing, expiry, kill switch ----------------------------------------------------

export async function readChannel(
  tx: TenantTx,
  input: { channelId: string; sessionId: string; afterSeq?: number },
) {
  const [ch] = await tx.select().from(channels).where(eq(channels.id, input.channelId));
  if (!ch) throw new CollabError("not_found", "No such channel.");
  const parts = await tx
    .select()
    .from(channelParticipants)
    .where(eq(channelParticipants.channelId, input.channelId));
  if (!parts.some((p) => p.sessionId === input.sessionId))
    throw new CollabError("forbidden", "Your session isn't in this channel.");
  const messages = await tx
    .select()
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.channelId, input.channelId),
        sql`${channelMessages.seq} > ${input.afterSeq ?? 0}`,
      ),
    )
    .orderBy(channelMessages.seq)
    .limit(200);
  const active = await tx
    .select()
    .from(leases)
    .where(
      and(
        eq(leases.channelId, input.channelId),
        isNull(leases.releasedAt),
        sql`${leases.expiresAt} > now()`,
      ),
    );
  const [agreement] = await tx
    .select()
    .from(agreements)
    .where(eq(agreements.channelId, input.channelId))
    .orderBy(sql`${agreements.version} DESC`)
    .limit(1);
  return {
    channel: {
      id: ch.id,
      status: ch.status,
      purpose: ch.purposeRedacted,
      scope: ch.scope,
      closes_at: ch.closesAt?.toISOString() ?? null,
    },
    participants: parts.map((p) => ({
      session_id: p.sessionId,
      you: p.sessionId === input.sessionId,
      approval: p.approval,
    })),
    messages: messages.map((m) => ({
      seq: m.seq,
      from: m.fromSession === input.sessionId ? "you" : "other agent",
      type: m.type,
      body: m.bodyRedacted,
      at: m.createdAt.toISOString(),
    })),
    leases: active.map((l) => ({
      resource: l.resource,
      holder: l.holderSession === input.sessionId ? "you" : "other agent",
      fencing_token: l.fencingToken,
      expires_at: l.expiresAt.toISOString(),
    })),
    agreement: agreement
      ? {
          version: agreement.version,
          body: agreement.bodyRedacted,
          accepted_by_all: parts.every((p) => agreement.acceptedBy.includes(p.sessionId)),
        }
      : null,
  };
}

export async function closeChannel(
  tx: TenantTx,
  tenantId: string,
  input: {
    channelId: string;
    by: { sessionId?: string; memberId?: string; system?: true };
    reason: string;
    status?: "closed" | "expired";
  },
) {
  const [ch] = await tx.select().from(channels).where(eq(channels.id, input.channelId));
  if (!ch) throw new CollabError("not_found", "No such channel.");
  if (input.by.sessionId || input.by.memberId) {
    const parts = await tx
      .select()
      .from(channelParticipants)
      .where(eq(channelParticipants.channelId, input.channelId));
    const ok = parts.some(
      (p) => p.sessionId === input.by.sessionId || p.memberId === input.by.memberId,
    );
    if (!ok && !input.by.system)
      throw new CollabError("forbidden", "Only participants or an admin can close a channel.");
  }
  if (!["requested", "open"].includes(ch.status)) return ch.status;
  const status = input.status ?? "closed";
  await tx
    .update(channels)
    .set({ status, closedAt: new Date(), closeReason: input.reason.slice(0, 300) })
    .where(eq(channels.id, input.channelId));
  await tx
    .update(leases)
    .set({ releasedAt: new Date() })
    .where(and(eq(leases.channelId, input.channelId), isNull(leases.releasedAt)));
  await appendAuditEvent(tx, tenantId, {
    actorType: input.by.memberId ? "member" : "system",
    actorId: input.by.memberId ?? null,
    action: `channel.${status}`,
    targetType: "channel",
    targetId: input.channelId,
    payload: { reason: input.reason.slice(0, 200) },
  });
  await notify(tx, tenantId);
  return status;
}

/** Closes channels past their time limit and stale requests. Returns how many closed. */
export async function expireChannels(tx: TenantTx, tenantId: string): Promise<number> {
  const due = await tx
    .select({ id: channels.id })
    .from(channels)
    .where(
      sql`(${channels.status} = 'open' AND ${channels.closesAt} < now())
          OR (${channels.status} = 'requested' AND ${channels.createdAt} < now() - interval '1 day')`,
    );
  for (const c of due)
    await closeChannel(tx, tenantId, {
      channelId: c.id,
      by: { system: true },
      reason: "time limit",
      status: "expired",
    });
  return due.length;
}

/** The admin kill switch: off closes every channel now and blocks new ones. */
export async function setChannelsEnabled(
  tx: TenantTx,
  tenantId: string,
  memberId: string,
  enabled: boolean,
) {
  await tx
    .insert(collabSettings)
    .values({ tenantId, enabled })
    .onConflictDoUpdate({
      target: collabSettings.tenantId,
      set: { enabled, updatedAt: new Date() },
    });
  let closed = 0;
  if (!enabled) {
    const live = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(inArray(channels.status, ["requested", "open"]));
    for (const c of live) {
      await closeChannel(tx, tenantId, {
        channelId: c.id,
        by: { system: true },
        reason: "channels turned off by an admin",
      });
      closed++;
    }
  }
  await appendAuditEvent(tx, tenantId, {
    actorType: "member",
    actorId: memberId,
    action: enabled ? "collab.enabled" : "collab.disabled",
    targetType: "tenant",
    targetId: tenantId,
    payload: { closed },
  });
  return { closed };
}

export const ALL_SHARE = SHARE_KINDS;
