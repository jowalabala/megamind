// `mm install`: adds the bridge's hooks to Claude Code's user settings and registers the
// local MCP server. Idempotent; `mm uninstall` reverses it. A backup of the settings file
// is written before any change.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { HOOK_EVENTS, type HookName } from "./hooks.ts";

type HookEntry = {
  matcher?: string;
  hooks: { type: "command"; command: string; timeout?: number }[];
};
type Settings = { hooks?: Record<string, HookEntry[]>; [k: string]: unknown };

export const settingsPath = () =>
  process.env.MM_CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");

const q = (s: string) => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;

/** How to run this bridge: `mm` once published; the built file during development. */
export function selfCommand(): string {
  const script = process.argv[1] ? resolve(process.argv[1]) : "";
  if (/\.(m?js)$/.test(script)) return `${q(process.execPath)} ${q(script)}`;
  return "mm";
}

const MARK = new RegExp(` hook (${Object.keys(HOOK_EVENTS).join("|")})$`);
const ours = (h: { command: string }) => MARK.test(h.command) && /\bmm(\.js")?\b/.test(h.command);

function read(): Settings {
  if (!existsSync(settingsPath())) return {};
  return JSON.parse(readFileSync(settingsPath(), "utf8")) as Settings;
}

function withoutOurs(settings: Settings): Settings {
  const hooks: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    const kept = entries
      .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !ours(h)) }))
      .filter((e) => e.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
  }
  const rest: Settings = { ...settings };
  delete rest.hooks;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

export function planInstall(settings: Settings, command = selfCommand()): Settings {
  const next = withoutOurs(settings);
  const hooks = { ...(next.hooks ?? {}) };
  for (const [name, event] of Object.entries(HOOK_EVENTS) as [HookName, string][]) {
    const entry: HookEntry = {
      ...(event === "PostToolUse" ? { matcher: "*" } : {}),
      hooks: [{ type: "command", command: `${command} hook ${name}`, timeout: 10 }],
    };
    hooks[event] = [...(hooks[event] ?? []), entry];
  }
  return { ...next, hooks };
}

function write(settings: Settings) {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.mm-backup`);
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

function claudeMcp(args: string[]): boolean {
  const r = spawnSync("claude", ["mcp", ...args], { encoding: "utf8", timeout: 20_000 });
  return r.status === 0;
}

export function install(options: { dryRun?: boolean; mcp?: boolean } = {}): string[] {
  const out: string[] = [];
  const next = planInstall(read());
  const mcpCmd = `claude mcp add --scope user master-mind -- ${selfCommand()} mcp`;
  if (options.dryRun) {
    out.push(`Would update ${settingsPath()} to:`, JSON.stringify(next.hooks, null, 2));
    if (options.mcp !== false) out.push(`Would run: ${mcpCmd}`);
    return out;
  }
  write(next);
  out.push(`Added Master Mind hooks to ${settingsPath()} (backup: settings.json.mm-backup).`);
  if (options.mcp !== false) {
    claudeMcp(["remove", "--scope", "user", "master-mind"]);
    const [cmd, ...args] = selfCommand()
      .match(/"(?:[^"\\]|\\.)*"|\S+/g)!
      .map((s) => (s.startsWith('"') ? (JSON.parse(s) as string) : s));
    if (claudeMcp(["add", "--scope", "user", "master-mind", "--", cmd!, ...args, "mcp"])) {
      out.push("Registered the master-mind MCP server with Claude Code.");
    } else {
      out.push("Couldn't run the claude CLI. Register the MCP server yourself:", `  ${mcpCmd}`);
    }
  }
  return out;
}

export function uninstall(options: { mcp?: boolean } = {}): string[] {
  write(withoutOurs(read()));
  const out = [`Removed Master Mind hooks from ${settingsPath()}.`];
  if (options.mcp !== false && claudeMcp(["remove", "--scope", "user", "master-mind"])) {
    out.push("Removed the master-mind MCP server from Claude Code.");
  }
  return out;
}

export function hooksInstalled(): boolean {
  try {
    return Object.values(read().hooks ?? {}).some((es) => es.some((e) => e.hooks.some(ours)));
  } catch {
    return false;
  }
}
