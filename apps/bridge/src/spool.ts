// Captured actions are appended to a per-session spool file and sent in batches, so a
// hook adds a few milliseconds, not a network round trip, and nothing is lost offline.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Api } from "./api.ts";
import type { ActionEvent } from "./capture.ts";
import { logError, spoolDir } from "./config.ts";

export interface SpoolSession {
  id: string;
  repo?: string;
  branch?: string;
  tool: string;
}

interface Line {
  session: SpoolSession;
  event: ActionEvent;
}

const FLUSH_EVERY_MS = 5_000;
const FLUSH_AT_EVENTS = 20;
const MAX_AGE_MS = 7 * 24 * 3600_000;
const MAX_SPOOL_BYTES = 5 * 1024 * 1024;
const BATCH = 100;

const fileFor = (sessionId: string) =>
  join(spoolDir(), `${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}.ndjson`);
const marker = () => join(spoolDir(), ".last-flush");

export function append(session: SpoolSession, event: ActionEvent): void {
  mkdirSync(spoolDir(), { recursive: true, mode: 0o700 });
  const file = fileFor(session.id);
  if (existsSync(file) && statSync(file).size > MAX_SPOOL_BYTES) {
    // Offline for a long time: stop growing rather than fill the disk.
    logError("spool", new Error("spool full; dropping new events"));
    return;
  }
  appendFileSync(file, JSON.stringify({ session, event } satisfies Line) + "\n", { mode: 0o600 });
}

export function pendingCount(): number {
  if (!existsSync(spoolDir())) return 0;
  return readdirSync(spoolDir())
    .filter((f) => f.endsWith(".ndjson"))
    .reduce(
      (n, f) => n + readFileSync(join(spoolDir(), f), "utf8").split("\n").filter(Boolean).length,
      0,
    );
}

export function flushDue(sessionId: string, now = Date.now()): boolean {
  const file = fileFor(sessionId);
  if (!existsSync(file)) return false;
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).length;
  if (lines >= FLUSH_AT_EVENTS) return true;
  return !existsSync(marker()) || now - statSync(marker()).mtimeMs > FLUSH_EVERY_MS;
}

/** Sends every spooled event. Events that fail to send go back into the spool. */
export async function flush(api: Api, now = Date.now()): Promise<{ sent: number; kept: number }> {
  if (!existsSync(spoolDir())) return { sent: 0, kept: 0 };
  mkdirSync(spoolDir(), { recursive: true, mode: 0o700 });
  writeFileSync(marker(), "");
  utimesSync(marker(), new Date(now), new Date(now));
  let sent = 0;
  let kept = 0;

  for (const name of readdirSync(spoolDir()).filter((f) => f.endsWith(".ndjson"))) {
    const file = join(spoolDir(), name);
    // Claim the file atomically so concurrent hooks don't send the same events twice.
    const claimed = `${file}.sending-${process.pid}-${now}`;
    try {
      renameSync(file, claimed);
    } catch {
      continue; // another process got it
    }
    const lines = readFileSync(claimed, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Line];
        } catch {
          return [];
        }
      })
      .filter((l) => now - Date.parse(l.event.occurred_at) < MAX_AGE_MS);

    const failed: Line[] = [];
    for (let i = 0; i < lines.length; i += BATCH) {
      const chunk = lines.slice(i, i + BATCH);
      try {
        // A spool file holds one session, so the first line's session describes all.
        await api.post(
          "/v1/actions",
          {
            session: chunk[0]!.session,
            events: chunk.map((l) => l.event),
          },
          4_000,
        );
        sent += chunk.length;
      } catch (err) {
        logError("flush", err);
        // 4xx other than rate limits won't succeed on retry; drop those batches.
        const status = (err as { status?: number }).status;
        if (status && status >= 400 && status < 500 && status !== 429 && status !== 401) continue;
        failed.push(...chunk);
      }
    }
    if (failed.length) {
      appendFileSync(file, failed.map((l) => JSON.stringify(l) + "\n").join(""), { mode: 0o600 });
      kept += failed.length;
    }
    rmSync(claimed, { force: true });
  }
  return { sent, kept };
}
