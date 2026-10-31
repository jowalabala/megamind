// Channel operations for agents (REST and MCP). Each call resolves the agent's own session,
// runs the collab core in the tenant's transaction, and maps its errors to HTTP codes.
import {
  acceptAgreement,
  claim,
  closeChannel,
  CollabError,
  proposeAgreement,
  readChannel,
  release,
  requestChannel,
  send,
} from "@mm/collab";
import {
  agentSessions,
  and,
  eq,
  type AuthenticatedAgent,
  type MasterMindDb,
  type TenantTx,
} from "@mm/db";
import type { RedactorFor } from "@mm/ingest";
import type { ChannelHandlers } from "@mm/mcp";

export const STATUS: Record<CollabError["code"], number> = {
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  closed: 409,
  policy: 422,
  blocked: 422,
};

export interface ChannelDeps {
  db: MasterMindDb;
  redactorFor: RedactorFor;
  /** Where people approve requests, e.g. https://app.example.com */
  webUrl?: string;
}

async function mySession(
  tx: TenantTx,
  agent: AuthenticatedAgent,
  clientSessionId: string | undefined,
) {
  if (!clientSessionId) throw new CollabError("not_found", "Pass your session_id.");
  const [s] = await tx
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.agentIdentityId, agent.agentId),
        eq(agentSessions.clientSessionId, clientSessionId),
      ),
    );
  if (!s)
    throw new CollabError(
      "not_found",
      "Unknown session for this agent. Announce an intent or connect first.",
    );
  return s.id;
}

export function channelHandlers(deps: ChannelDeps, agent: AuthenticatedAgent): ChannelHandlers {
  if (!agent.scopes.includes("collab")) {
    const no = async () => {
      throw new CollabError("forbidden", "This agent key does not have the collab scope.");
    };
    return {
      request: no,
      send: no,
      read: no,
      claim: no,
      release: no,
      propose: no,
      accept: no,
      close: no,
    };
  }
  const t = agent.tenantId;
  const run = <R>(fn: (tx: TenantTx) => Promise<R>) => deps.db.withTenant(t, fn);
  return {
    request: async (i) => {
      const redactor = await deps.redactorFor(t);
      const out = await run(async (tx) =>
        requestChannel(tx, t, redactor, {
          fromSessionId: await mySession(tx, agent, i.session_id),
          toSessionId: i.with_session_id,
          purpose: i.purpose,
          resources: i.resources,
          share: i.share,
          ttlMinutes: i.ttl_minutes,
        }),
      );
      return {
        channel_id: out.id,
        status: out.status,
        approval_url: deps.webUrl ? `${deps.webUrl.replace(/\/+$/, "")}/channels` : undefined,
      };
    },
    send: async (i) => {
      const redactor = await deps.redactorFor(t);
      return run(async (tx) =>
        send(tx, t, redactor, {
          channelId: i.channel_id,
          sessionId: await mySession(tx, agent, i.session_id),
          type: i.type,
          body: i.body,
        }),
      );
    },
    read: (i) =>
      run(async (tx) =>
        readChannel(tx, {
          channelId: i.channel_id,
          sessionId: await mySession(tx, agent, i.session_id),
          afterSeq: i.after_seq,
        }),
      ),
    claim: async (i) => {
      const r = await run(async (tx) =>
        claim(tx, t, {
          channelId: i.channel_id,
          sessionId: await mySession(tx, agent, i.session_id),
          resource: i.resource,
          minutes: i.minutes,
        }),
      );
      return { fencing_token: r.fencingToken, expires_at: r.expiresAt.toISOString() };
    },
    release: (i) =>
      run(async (tx) =>
        release(tx, t, {
          channelId: i.channel_id,
          sessionId: await mySession(tx, agent, i.session_id),
          resource: i.resource,
          fencingToken: i.fencing_token,
        }),
      ),
    propose: async (i) => {
      const redactor = await deps.redactorFor(t);
      return run(async (tx) =>
        proposeAgreement(tx, t, redactor, {
          channelId: i.channel_id,
          sessionId: await mySession(tx, agent, i.session_id),
          body: i.body,
          expectedVersion: i.expected_version,
        }),
      );
    },
    accept: (i) =>
      run(async (tx) =>
        acceptAgreement(tx, t, {
          channelId: i.channel_id,
          sessionId: await mySession(tx, agent, i.session_id),
          version: i.version,
        }),
      ),
    close: async (i) => ({
      status: await run(async (tx) =>
        closeChannel(tx, t, {
          channelId: i.channel_id,
          by: { sessionId: await mySession(tx, agent, i.session_id) },
          reason: i.reason,
        }),
      ),
    }),
  };
}
