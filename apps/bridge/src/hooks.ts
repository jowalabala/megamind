// Claude Code hooks. Each runs as a short process with the event JSON on stdin.
// A hook must never break or slow the agent: every failure is logged and swallowed.
import { createApi } from "./api.ts";
import { toActionEvent, type HookPayload } from "./capture.ts";
import { logError, readConfig } from "./config.ts";
import { loadKey } from "./credentials.ts";
import { repoInfo } from "./git.ts";
import { append, flush, flushDue } from "./spool.ts";

export const HOOK_EVENTS = {
  "session-start": "SessionStart",
  "post-tool-use": "PostToolUse",
  stop: "Stop",
  "session-end": "SessionEnd",
} as const;
export type HookName = keyof typeof HOOK_EVENTS;

const CONTEXT = [
  "Master Mind is on for this session. Your tool use is captured as short summaries",
  "(secrets are removed on this machine first) so the team can learn what works.",
  "Before non-trivial work, call the master-mind search_history tool to see related past work",
  "and how it turned out. When you finish a meaningful task, call log_task.",
].join(" ");

function apiOrNull() {
  const cfg = readConfig();
  const key = cfg && loadKey(cfg.apiUrl);
  return cfg && key ? createApi(cfg.apiUrl, key.key) : null;
}

export async function runHook(name: HookName, payload: HookPayload): Promise<string | null> {
  try {
    const cfg = readConfig();
    if (!cfg) return null; // not logged in: stay silent
    const sessionId = payload.session_id;

    if (name === "session-start") {
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: CONTEXT },
      });
    }

    if (name === "post-tool-use") {
      if (!sessionId) return null;
      const info = repoInfo(payload.cwd ?? process.cwd());
      const event = toActionEvent(payload, info);
      if (!event) return null;
      append(
        {
          id: sessionId,
          repo: info?.repo,
          branch: info?.branch ?? undefined,
          tool: "claude_code",
        },
        event,
      );
      if (!flushDue(sessionId)) return null;
    }

    // post-tool-use (when due), stop and session-end send what's spooled.
    const api = apiOrNull();
    if (api) await flush(api);
  } catch (err) {
    logError(`hook ${name}`, err);
  }
  return null;
}
