// Live presence for one Claude Code session.
//
// SessionStart starts `mm presence <session> <cwd>` in the background. It fetches a 5-minute
// gateway token from the API, connects (token offered as a WebSocket subprotocol), says hello,
// sends heartbeats, and keeps the latest presence list in a file the hooks read. It reconnects
// with backoff, and says goodbye and exits when SessionEnd asks it to or the session has been
// idle (no tool use) for 20 minutes.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLOSE,
  HEARTBEAT_MS,
  PROTOCOL,
  TOKEN_PROTOCOL_PREFIX,
  type PresenceEntry,
} from "@mm/realtime";
import { home } from "./config.ts";

export const sessionsDir = () => join(home(), "sessions");
const base = (sessionId: string) =>
  join(sessionsDir(), createHash("sha256").update(sessionId).digest("hex").slice(0, 32));
export const files = (sessionId: string) => ({
  pid: `${base(sessionId)}.pid`,
  presence: `${base(sessionId)}.presence.json`,
  alive: `${base(sessionId)}.alive`,
  stop: `${base(sessionId)}.stop`,
  injected: `${base(sessionId)}.injected`,
});

const IDLE_MS = 20 * 60_000;

export interface PresenceDeps {
  sessionId: string;
  session: { repo?: string; branch?: string; tool: string; private?: boolean };
  getToken: () => Promise<{ token: string; gatewayUrl: string }>;
  WebSocketImpl?: typeof WebSocket;
  heartbeatMs?: number;
  /** How often the stop/idle files are checked. */
  checkMs?: number;
  log?: (msg: string) => void;
}

/** Runs until stopped or idle. Resolves once it has said goodbye. */
export async function runPresence(deps: PresenceDeps): Promise<void> {
  const f = files(deps.sessionId);
  mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
  writeFileSync(f.pid, String(process.pid), { mode: 0o600 });
  writeFileSync(f.alive, "", { mode: 0o600 });
  rmSync(f.stop, { force: true });
  const WS = deps.WebSocketImpl ?? WebSocket;
  let ws: WebSocket | null = null;
  let stopping = false;
  let backoff = 1_000;

  const shouldStop = () =>
    existsSync(f.stop) || !existsSync(f.alive) || Date.now() - statSync(f.alive).mtimeMs > IDLE_MS;

  const connect = async () => {
    const { token, gatewayUrl } = await deps.getToken();
    const url = `${gatewayUrl.replace(/\/+$/, "")}/ws`;
    return new Promise<void>((resolve) => {
      const sock = new WS(url, [PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`]);
      ws = sock;
      let beat: NodeJS.Timeout | undefined;
      sock.onopen = () => {
        backoff = 1_000;
        sock.send(
          JSON.stringify({ type: "hello", session: { id: deps.sessionId, ...deps.session } }),
        );
        beat = setInterval(
          () => sock.send(JSON.stringify({ type: "heartbeat" })),
          deps.heartbeatMs ?? HEARTBEAT_MS,
        );
      };
      sock.onmessage = (e) => {
        try {
          const m = JSON.parse(String(e.data)) as { type: string; sessions?: PresenceEntry[] };
          if (m.type === "presence") {
            writeFileSync(
              f.presence,
              JSON.stringify({ at: new Date().toISOString(), sessions: m.sessions }),
              {
                mode: 0o600,
              },
            );
          }
        } catch {
          // ignore malformed frames
        }
      };
      sock.onclose = (e) => {
        clearInterval(beat);
        ws = null;
        // Opted out, or the key was revoked: don't keep trying.
        if (e.code === CLOSE.optedOut || e.code === CLOSE.unauthorized) stopping = true;
        resolve();
      };
      sock.onerror = () => {
        // onclose follows
      };
    });
  };

  const watcher = setInterval(() => {
    if (!stopping && shouldStop()) {
      stopping = true;
      const sock = ws as WebSocket | null;
      if (sock && sock.readyState === WS.OPEN) {
        sock.send(JSON.stringify({ type: "bye" }));
        // The gateway closes after bye; force it if it doesn't.
        setTimeout(() => sock.close(), 2_000);
      }
    }
  }, deps.checkMs ?? 5_000);

  try {
    while (!stopping) {
      try {
        await connect();
      } catch (err) {
        deps.log?.(`presence: ${(err as Error).message}`);
      }
      if (stopping) break;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
      if (shouldStop()) break;
    }
  } finally {
    clearInterval(watcher);
    for (const p of [f.pid, f.presence, f.stop, f.injected]) rmSync(p, { force: true });
  }
}

const running = (pidFile: string) => {
  try {
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Starts the background process for a session unless it's already running. */
export function startPresenceDaemon(command: string[], sessionId: string, cwd: string): boolean {
  const f = files(sessionId);
  mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
  writeFileSync(f.alive, "", { mode: 0o600 });
  if (running(f.pid)) return false;
  const [cmd, ...args] = command;
  const child = spawn(cmd!, [...args, "presence", sessionId, cwd], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  return true;
}

export function touchAlive(sessionId: string): void {
  try {
    writeFileSync(files(sessionId).alive, "", { mode: 0o600 });
  } catch {
    // no sessions dir yet: presence isn't running
  }
}

export function requestStop(sessionId: string): void {
  try {
    writeFileSync(files(sessionId).stop, "", { mode: 0o600 });
  } catch {
    // nothing running
  }
}

/** Others' sessions, as a short context line, only when the list changed since last shown. */
export function presenceContext(sessionId: string): string | null {
  const f = files(sessionId);
  let snapshot: { sessions: PresenceEntry[] };
  try {
    snapshot = JSON.parse(readFileSync(f.presence, "utf8")) as { sessions: PresenceEntry[] };
  } catch {
    return null;
  }
  const others = snapshot.sessions.filter((s) => !s.you);
  const key = createHash("sha256")
    .update(
      others
        .map((s) => `${s.session_id}|${s.repo}|${s.branch}`)
        .sort()
        .join("\n"),
    )
    .digest("hex");
  const last = existsSync(f.injected) ? readFileSync(f.injected, "utf8") : "";
  if (key === last) return null;
  writeFileSync(f.injected, key, { mode: 0o600 });
  if (others.length === 0)
    return last ? "Master Mind: no other teammates' agents are active now." : null;
  const lines = others.map(
    (s) =>
      `- ${s.who}: ${s.tool ?? "agent"}${s.repo ? ` in ${s.repo}` : ""}${s.branch ? ` (branch ${s.branch})` : ""}`,
  );
  return [
    "Master Mind: teammates' agents active right now (call whats_happening for details):",
    ...lines,
  ].join("\n");
}
