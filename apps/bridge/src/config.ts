// Local state lives in ~/.mastermind (MM_HOME overrides it, e.g. in tests):
//   config.json   API URL (no secrets)
//   spool/        captured actions waiting to be sent, one file per session
//   bridge.log    errors only, never captured content
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const VERSION = "0.1.0";
export const CLIENT_HEADER = `mm-bridge/${VERSION}`;

export const home = () => process.env.MM_HOME ?? join(homedir(), ".mastermind");
export const spoolDir = () => join(home(), "spool");

export interface BridgeConfig {
  apiUrl: string;
}

export function readConfig(): BridgeConfig | null {
  try {
    const c = JSON.parse(readFileSync(join(home(), "config.json"), "utf8")) as BridgeConfig;
    return process.env.MM_API_URL ? { ...c, apiUrl: process.env.MM_API_URL } : c;
  } catch {
    return process.env.MM_API_URL ? { apiUrl: process.env.MM_API_URL } : null;
  }
}

export function writeConfig(c: BridgeConfig): void {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  writeFileSync(join(home(), "config.json"), JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}

/** Errors only. Never pass captured content here. */
export function logError(where: string, err: unknown): void {
  try {
    mkdirSync(home(), { recursive: true, mode: 0o700 });
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    appendFileSync(
      join(home(), "bridge.log"),
      `${new Date().toISOString()} ${where} ${message.slice(0, 300)}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Logging must never break the agent.
  }
}
