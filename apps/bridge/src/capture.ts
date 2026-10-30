// Turns a Claude Code PostToolUse hook payload into an action event: metadata and a short
// summary only (tool, file, command), never file contents or tool output. Secrets are
// removed here, before anything leaves the machine; the server redacts again.
import { randomUUID } from "node:crypto";
import { applyDetections, secretDetector } from "@mm/privacy";
import { changedRanges, compactRanges, projectPath, resourceKey, type RepoInfo } from "./git.ts";

export interface HookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

export interface ActionEvent {
  id: string;
  kind: "tool_call" | "edit" | "command" | "message";
  summary: string;
  resources: string[];
  occurred_at: string;
}

/** Secrets out; formatting kept. */
export const stripSecrets = (text: string) =>
  applyDetections(text, secretDetector.detect(text)).text;

/** Secrets out, whitespace collapsed, length capped: for one-line summaries. */
export function scrub(text: string, max = 200): string {
  const clean = stripSecrets(text).replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
// Bookkeeping tools that say nothing about the work.
const SKIP = new Set([
  "TodoWrite",
  "TodoRead",
  "ExitPlanMode",
  "BashOutput",
  "KillShell",
  "KillBash",
]);

export function toActionEvent(
  p: HookPayload,
  info: RepoInfo | null,
  now = new Date(),
): ActionEvent | null {
  const tool = p.tool_name;
  if (!tool || SKIP.has(tool) || tool.startsWith("mcp__master-mind__")) return null;
  const input = p.tool_input ?? {};
  const cwd = p.cwd ?? process.cwd();
  const base = { id: randomUUID(), occurred_at: now.toISOString() };

  const file = (input.file_path ?? input.notebook_path) as string | undefined;
  const rel = typeof file === "string" ? projectPath(file, cwd, info) : null;
  const fileKey = (ranges?: [number, number][]) => {
    if (!rel) return [];
    if (!info) return [`local:${rel}`];
    if (!ranges?.length) return [resourceKey(info.repo, rel)];
    return compactRanges(ranges).map((r) => resourceKey(info.repo, rel, r));
  };

  if (EDIT_TOOLS.has(tool)) {
    const ranges = rel && info ? changedRanges(info.root, rel) : [];
    const verb = tool === "Write" ? "Wrote" : "Edited";
    return {
      ...base,
      kind: "edit",
      summary: rel ? `${verb} ${rel}` : `${verb} a file outside the project`,
      resources: fileKey(ranges),
    };
  }
  if (tool === "Read") {
    return {
      ...base,
      kind: "tool_call",
      summary: rel ? `Read ${rel}` : "Read a file outside the project",
      resources: fileKey(),
    };
  }
  if (tool === "Bash") {
    const cmd = typeof input.command === "string" ? scrub(input.command) : "";
    return {
      ...base,
      kind: "command",
      summary: cmd ? `Ran: ${cmd}` : "Ran a command",
      resources: [],
    };
  }
  if (tool === "Grep" || tool === "Glob") {
    return { ...base, kind: "tool_call", summary: "Searched the code", resources: [] };
  }
  if (tool === "WebFetch") {
    let host = "";
    try {
      host = new URL(String(input.url)).hostname;
    } catch {
      // ignore
    }
    return {
      ...base,
      kind: "tool_call",
      summary: host ? `Fetched ${host}` : "Fetched a web page",
      resources: [],
    };
  }
  if (tool === "WebSearch") {
    return { ...base, kind: "tool_call", summary: "Searched the web", resources: [] };
  }
  if (tool === "Task" || tool === "Agent") {
    const d = typeof input.description === "string" ? scrub(input.description, 120) : "";
    return {
      ...base,
      kind: "tool_call",
      summary: d ? `Delegated: ${d}` : "Delegated to a subagent",
      resources: [],
    };
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool);
  if (mcp)
    return { ...base, kind: "tool_call", summary: `Used ${mcp[1]}/${mcp[2]}`, resources: [] };
  return { ...base, kind: "tool_call", summary: `Used ${scrub(tool, 60)}`, resources: [] };
}
