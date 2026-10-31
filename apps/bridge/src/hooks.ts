// Claude Code hooks. Each runs as a short process with the event JSON on stdin.
// A hook must never break or slow the agent: every failure is logged and swallowed.
import { createApi } from "./api.ts";
import { toActionEvent, type HookPayload } from "./capture.ts";
import { logError, readConfig } from "./config.ts";
import { loadKey } from "./credentials.ts";
import { repoInfo } from "./git.ts";
import {
  presenceContext,
  requestStop,
  startPresenceDaemon,
  takeAlerts,
  takeChannelEvents,
  touchAlive,
} from "./presence.ts";
import { skillsContext, syncSkills } from "./skills.ts";
import { append, flush, flushDue } from "./spool.ts";

export const HOOK_EVENTS = {
  "session-start": "SessionStart",
  "user-prompt-submit": "UserPromptSubmit",
  "post-tool-use": "PostToolUse",
  stop: "Stop",
  "session-end": "SessionEnd",
} as const;
export type HookName = keyof typeof HOOK_EVENTS;

const CONTEXT = [
  "Master Mind is on for this session. Your tool use is captured as short summaries",
  "(secrets are removed on this machine first) so the team can learn what works.",
  "Before non-trivial work, call the master-mind search_skills tool for the team's approved practices,",
  "and search_history to see related past work and how it turned out. Call announce_intent when you start a task, with the files you expect",
  "to touch: you'll be alerted if a teammate's agent is changing the same code.",
  "whats_happening shows teammates' agents working right now.",
  "When you finish a meaningful task, call log_task (with skills_used for any skills you followed).",
].join(" ");

/** How to run this bridge as a child process. */
export function selfArgv(): string[] {
  const script = process.argv[1];
  return script && /\.(m?js)$/.test(script) ? [process.execPath, script] : ["mm"];
}

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
      if (sessionId && process.env.MM_PRESENCE !== "off") {
        startPresenceDaemon(selfArgv(), sessionId, payload.cwd ?? process.cwd());
      }
      // Bring team skills up to date. Quick or not at all: a slow API never delays the agent.
      let skills: string | null = null;
      const api = process.env.MM_SKILLS_SYNC === "off" ? null : apiOrNull();
      if (api) {
        try {
          skills = skillsContext((await syncSkills(api)).skills);
        } catch (err) {
          logError("skills sync", err);
        }
      }
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: [CONTEXT, skills].filter(Boolean).join("\n\n"),
        },
      });
    }

    if (name === "user-prompt-submit") {
      const context = sessionId
        ? [takeAlerts(sessionId), takeChannelEvents(sessionId), presenceContext(sessionId)]
            .filter(Boolean)
            .join("\n\n") || null
        : null;
      return context
        ? JSON.stringify({
            hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
          })
        : null;
    }

    let reply: string | null = null;
    if (name === "post-tool-use") {
      if (!sessionId) return null;
      touchAlive(sessionId);
      // Overlap alerts reach the agent on its next tool call, not only its next prompt.
      const alerts =
        [takeAlerts(sessionId), takeChannelEvents(sessionId)].filter(Boolean).join("\n\n") || null;
      if (alerts) {
        reply = JSON.stringify({
          hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: alerts },
        });
      }
      const info = repoInfo(payload.cwd ?? process.cwd());
      const event = toActionEvent(payload, info);
      if (!event) return reply;
      append(
        {
          id: sessionId,
          repo: info?.repo,
          branch: info?.branch ?? undefined,
          tool: "claude_code",
        },
        event,
      );
      if (!flushDue(sessionId)) return reply;
    }

    if (name === "session-end" && sessionId) requestStop(sessionId);
    // post-tool-use (when due), stop and session-end send what's spooled.
    const api = apiOrNull();
    if (api) await flush(api);
    return reply;
  } catch (err) {
    logError(`hook ${name}`, err);
  }
  return null;
}
