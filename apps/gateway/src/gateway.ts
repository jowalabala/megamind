// The real-time gateway: one WebSocket per agent session, carrying presence.
//
// Clients connect with a short-lived token from the API (offered as a subprotocol, so it never
// appears in a URL), say hello with their session, then send heartbeats. Whenever presence in
// a tenant changes, any gateway instance NOTIFYs; every instance then recomputes what each of
// its viewers may see (presenceRepo.liveSessions applies the visibility rules) and pushes it
// if it changed. A periodic sweep also catches sessions that went quiet.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  agentIdentities,
  assertTenantId,
  eq,
  members,
  presenceRepo,
  sql,
  type MasterMindDb,
} from "@mm/db";
import { ALERT_CHANNEL, alertsFor, describeAlert, markDelivered } from "@mm/awareness";
import { CHANNEL_NOTIFY } from "@mm/collab";
import { listen, type Listener } from "@mm/db/notify";
import type { RedactorFor } from "@mm/ingest";
import {
  CLOSE,
  clientMessage,
  PRESENCE_TTL_MS,
  PROTOCOL,
  TOKEN_PROTOCOL_PREFIX,
  verifyGatewayToken,
  type ChannelEvent,
  type GatewayClaims,
  type ServerMessage,
} from "@mm/realtime";
import { WebSocket, WebSocketServer } from "ws";

export const CHANNEL = "mm_presence";

export interface GatewayOptions {
  db: MasterMindDb;
  /** For LISTEN (mm_app connection string). */
  listenUrl: string;
  ssl?: { rejectUnauthorized: boolean } | boolean;
  secret: string;
  redactorFor: RedactorFor;
  /** How often every viewer's presence is recomputed regardless of notifications. */
  sweepMs?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

interface Conn {
  ws: WebSocket;
  claims: GatewayClaims;
  sessionId: string | null;
  clientSessionId: string | null;
  lastPushed: string;
  lastHeartbeatWrite: number;
  lastAgentCheck: number;
  /** Timestamps of recent messages, for rate limiting. */
  recent: number[];
}

const MAX_MESSAGES_PER_10S = 20;
const AGENT_RECHECK_MS = 5 * 60_000;

function tokenFrom(req: IncomingMessage): string | null {
  const offered = String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((p) => p.trim());
  if (!offered.includes(PROTOCOL)) return null;
  const t = offered.find((p) => p.startsWith(TOKEN_PROTOCOL_PREFIX));
  return t ? t.slice(TOKEN_PROTOCOL_PREFIX.length) : null;
}

export async function createGateway(options: GatewayOptions) {
  const log = options.log ?? (() => {});
  const conns = new Set<Conn>();
  const byTenant = (tenantId: string) =>
    [...conns].filter((c) => c.claims.tenantId === tenantId && c.sessionId);

  const send = (c: Conn, msg: ServerMessage) => {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  };

  /** Recomputes and pushes presence to every viewer in a tenant, if it changed for them. */
  async function pushTenant(tenantId: string) {
    const viewers = byTenant(tenantId);
    if (viewers.length === 0) return;
    await options.db.withTenant(tenantId, async (tx) => {
      const cache = new Map<string, Awaited<ReturnType<typeof presenceRepo.liveSessions>>>();
      for (const c of viewers) {
        let sessions = cache.get(c.claims.memberId);
        if (!sessions) {
          sessions = await presenceRepo.liveSessions(tx, c.claims.memberId, PRESENCE_TTL_MS);
          cache.set(c.claims.memberId, sessions);
        }
        // Change detection ignores last_seen, so heartbeats alone don't cause pushes.
        const hash = createHash("sha256")
          .update(JSON.stringify(sessions.map(({ last_seen: _l, ...s }) => s)))
          .digest("hex");
        if (hash !== c.lastPushed) {
          c.lastPushed = hash;
          send(c, { type: "presence", sessions });
        }
      }
    });
  }

  /** Sends each viewer in a tenant the overlap alerts it hasn't had yet, then marks them sent. */
  async function pushAlerts(tenantId: string) {
    for (const c of byTenant(tenantId)) {
      await options.db.withTenant(tenantId, async (tx) => {
        const alerts = await alertsFor(tx, c.sessionId!, c.claims.memberId, { undelivered: true });
        if (alerts.length === 0 || c.ws.readyState !== WebSocket.OPEN) return;
        send(c, { type: "alert", alerts: alerts.map((a) => ({ ...a, text: describeAlert(a) })) });
        await markDelivered(
          tx,
          c.sessionId!,
          alerts.map((a) => a.id),
        );
      });
    }
  }

  /** Channel status changes and new messages from the other side, once each per session. */
  async function pushChannels(tenantId: string) {
    for (const c of byTenant(tenantId)) {
      await options.db.withTenant(tenantId, async (tx) => {
        const rows = await tx.execute<{
          channel_id: string;
          status: string;
          purpose: string;
          approval: string;
          delivered_seq: number;
          delivered_status: string | null;
        }>(sql`
          SELECT ch.id AS channel_id, ch.status, ch.purpose_redacted AS purpose, p.approval,
                 p.delivered_seq, p.delivered_status
            FROM channel_participants p JOIN channels ch ON ch.id = p.channel_id
           WHERE p.session_id = ${c.sessionId}`);
        const events: ChannelEvent[] = [];
        for (const r of rows.rows) {
          if (r.status !== r.delivered_status) {
            const waiting = r.status === "requested" && r.approval === "pending";
            const text =
              r.status === "requested"
                ? `A channel was requested: "${r.purpose}". It opens once both people approve in Master Mind${waiting ? " (your person hasn't yet)" : ""}.`
                : r.status === "open"
                  ? `Channel ${r.channel_id} is open: "${r.purpose}". Use channel_read and channel_send.`
                  : `Channel ${r.channel_id} is ${r.status}.`;
            events.push({
              kind: "status",
              channel_id: r.channel_id,
              status: r.status,
              purpose: r.purpose,
              waiting_for_you: waiting,
              text,
            });
          }
          const msgs = await tx.execute<{ seq: number; type: string; body: string }>(sql`
            SELECT seq, type, body_redacted AS body FROM channel_messages
             WHERE channel_id = ${r.channel_id} AND seq > ${r.delivered_seq} AND from_session <> ${c.sessionId}
             ORDER BY seq LIMIT 50`);
          for (const m of msgs.rows) {
            events.push({
              kind: "message",
              channel_id: r.channel_id,
              seq: Number(m.seq),
              type: m.type,
              body: m.body,
              text: `Untrusted message from the other agent in channel ${r.channel_id} (${m.type}): ${m.body}`,
            });
          }
          const maxSeq = Math.max(Number(r.delivered_seq), ...msgs.rows.map((m) => Number(m.seq)));
          await tx.execute(sql`
            UPDATE channel_participants SET delivered_status = ${r.status},
                   delivered_seq = GREATEST(delivered_seq, ${maxSeq},
                     (SELECT coalesce(max(seq), 0) FROM channel_messages
                       WHERE channel_id = ${r.channel_id} AND from_session = ${c.sessionId}))
             WHERE channel_id = ${r.channel_id} AND session_id = ${c.sessionId}`);
        }
        if (events.length && c.ws.readyState === WebSocket.OPEN)
          send(c, { type: "channel", events });
      });
    }
  }

  const notify = (tenantId: string) =>
    options.db.withTenant(tenantId, (tx) =>
      tx.execute(sql`SELECT pg_notify(${CHANNEL}, ${tenantId})`),
    );

  const listener: Listener = await listen(
    {
      connectionString: options.listenUrl,
      ssl: options.ssl,
      onError: (e) => log("gateway.listen_error", { message: e.message }),
    },
    CHANNEL,
    (payload) => {
      try {
        assertTenantId(payload);
      } catch {
        return;
      }
      void pushTenant(payload).catch((e: Error) =>
        log("gateway.push_error", { message: e.message }),
      );
    },
  );

  const alertListener: Listener = await listen(
    {
      connectionString: options.listenUrl,
      ssl: options.ssl,
      onError: (e) => log("gateway.listen_error", { message: e.message }),
    },
    ALERT_CHANNEL,
    (payload) => {
      try {
        assertTenantId(payload);
      } catch {
        return;
      }
      void pushAlerts(payload).catch((e: Error) =>
        log("gateway.alert_error", { message: e.message }),
      );
    },
  );

  const channelListener: Listener = await listen(
    {
      connectionString: options.listenUrl,
      ssl: options.ssl,
      onError: (e) => log("gateway.listen_error", { message: e.message }),
    },
    CHANNEL_NOTIFY,
    (payload) => {
      try {
        assertTenantId(payload);
      } catch {
        return;
      }
      void pushChannels(payload).catch((e: Error) =>
        log("gateway.channel_error", { message: e.message }),
      );
    },
  );

  const sweep = setInterval(() => {
    for (const t of new Set([...conns].map((c) => c.claims.tenantId))) {
      void pushTenant(t).catch((e: Error) => log("gateway.push_error", { message: e.message }));
    }
  }, options.sweepMs ?? 15_000);

  async function onMessage(c: Conn, raw: string) {
    const now = Date.now();
    c.recent = c.recent.filter((t) => now - t < 10_000);
    c.recent.push(now);
    if (c.recent.length > MAX_MESSAGES_PER_10S)
      return c.ws.close(CLOSE.rateLimited, "rate limited");

    let parsed;
    try {
      parsed = clientMessage.safeParse(JSON.parse(raw));
    } catch {
      parsed = null;
    }
    if (!parsed?.success) return c.ws.close(CLOSE.badMessage, "bad message");
    const msg = parsed.data;
    const { tenantId, memberId, agentId } = c.claims;

    // A revoked key ends its live connections too.
    if (now - c.lastAgentCheck > AGENT_RECHECK_MS) {
      c.lastAgentCheck = now;
      const [agent] = await options.db.withTenant(tenantId, (tx) =>
        tx
          .select({ revokedAt: agentIdentities.revokedAt })
          .from(agentIdentities)
          .where(eq(agentIdentities.id, agentId)),
      );
      if (!agent || agent.revokedAt) return c.ws.close(CLOSE.unauthorized, "revoked");
    }

    if (msg.type === "hello") {
      if (c.sessionId) return; // one session per connection
      const r = await options.redactorFor(tenantId);
      const ctx = await r.redactValue({
        repo: msg.session.repo,
        branch: msg.session.branch,
        tool: msg.session.tool,
      });
      const result = await options.db.withTenant(tenantId, async (tx) => {
        const [m] = await tx
          .select({ optOut: members.captureOptOut })
          .from(members)
          .where(eq(members.id, memberId));
        // Opting out of capture also means not appearing to others live.
        if (!m || m.optOut) return null;
        const s = await presenceRepo.upsertLiveSession(tx, tenantId, {
          agentId,
          memberId,
          clientSessionId: msg.session.id,
          context: JSON.parse(JSON.stringify(ctx.value)) as Record<string, unknown>,
          private: msg.session.private ?? false,
        });
        await tx.execute(sql`SELECT pg_notify(${CHANNEL}, ${tenantId})`);
        return s;
      });
      if (!result) return c.ws.close(CLOSE.optedOut, "capture opt-out");
      // The same session connecting again (e.g. a restarted bridge) replaces the old socket.
      for (const other of conns) {
        if (
          other !== c &&
          other.claims.agentId === agentId &&
          other.clientSessionId === msg.session.id
        ) {
          other.ws.close(CLOSE.replaced, "replaced");
        }
      }
      c.sessionId = result.id;
      c.clientSessionId = msg.session.id;
      c.lastHeartbeatWrite = now;
      send(c, { type: "welcome", session_id: result.id });
      await pushTenant(tenantId);
      // Anything that came up while this session was disconnected.
      await pushAlerts(tenantId);
      await pushChannels(tenantId);
      return;
    }
    if (!c.sessionId) return c.ws.close(CLOSE.badMessage, "hello first");
    if (msg.type === "heartbeat") {
      // Throttled: one write per 20 seconds is plenty for a 60-second presence window.
      if (now - c.lastHeartbeatWrite >= 20_000) {
        c.lastHeartbeatWrite = now;
        await options.db.withTenant(tenantId, (tx) => presenceRepo.heartbeat(tx, c.sessionId!));
      }
      return;
    }
    // bye: the session ended on purpose; others see it go at once.
    await options.db.withTenant(tenantId, (tx) => presenceRepo.endSession(tx, c.sessionId!));
    await notify(tenantId);
    c.sessionId = null;
    c.ws.close(1000, "bye");
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024,
    handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false),
  });

  const server: Server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    res.writeHead(404).end();
  });

  server.on("upgrade", (req, socket, head) => {
    const token = req.url?.split("?")[0] === "/ws" ? tokenFrom(req) : null;
    const claims = token ? verifyGatewayToken(options.secret, token) : null;
    if (!claims) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const c: Conn = {
        ws,
        claims,
        sessionId: null,
        clientSessionId: null,
        lastPushed: "",
        lastHeartbeatWrite: 0,
        // 0: the first message checks the agent is still active, then every 5 minutes.
        lastAgentCheck: 0,
        recent: [],
      };
      conns.add(c);
      log("gateway.connected", { tenantId: claims.tenantId, agentId: claims.agentId });
      // Messages for one connection are handled in order.
      let chain = Promise.resolve();
      ws.on("message", (data) => {
        chain = chain
          .then(() => onMessage(c, data.toString()))
          .catch((e: Error) => {
            log("gateway.message_error", { message: e.message });
            ws.close(1011, "error");
          });
      });
      ws.on("close", () => {
        conns.delete(c);
        // Not ended: a dropped connection may come straight back. Presence expires on its own.
        if (c.sessionId) void notify(claims.tenantId).catch(() => {});
      });
    });
  });

  return {
    server,
    connections: () => conns.size,
    async close() {
      clearInterval(sweep);
      for (const c of conns) c.ws.close(1001, "shutting down");
      await listener.close();
      await alertListener.close();
      await channelListener.close();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
