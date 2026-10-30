// The agent key lives in the OS keychain: macOS Keychain or the Linux Secret Service.
// The key is passed on stdin, never as a command-line argument (visible to other users in
// `ps`). MM_AGENT_KEY overrides everything (CI, containers). Without a keychain, a file
// readable only by you is the fallback, and `mm status` says so.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home } from "./config.ts";

const SERVICE = "mastermind-agent-key";
const KEY_RE = /^mm_(live|test)_[A-Za-z0-9]{40}$/;

export type Store = "env" | "macos-keychain" | "secret-service" | "file";

const fileStore = () => join(home(), "credentials");

function run(cmd: string, args: string[], input?: string) {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", timeout: 5_000 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

const has = (cmd: string) => spawnSync("which", [cmd], { encoding: "utf8" }).status === 0;

export function availableStore(): Exclude<Store, "env"> {
  if (process.env.MM_CREDENTIAL_STORE === "file") return "file";
  if (process.platform === "darwin" && has("security")) return "macos-keychain";
  if (process.platform === "linux" && has("secret-tool")) return "secret-service";
  return "file";
}

export function saveKey(apiUrl: string, key: string): Store {
  if (!KEY_RE.test(key)) throw new Error("That doesn't look like a Master Mind agent key.");
  const store = availableStore();
  if (store === "macos-keychain") {
    // `security -i` reads commands from stdin, so the key never appears in argv.
    const ok = run(
      "security",
      ["-i"],
      `add-generic-password -U -s ${SERVICE} -a "${apiUrl.replace(/"/g, "")}" -w ${key}\n`,
    ).ok;
    if (ok) return store;
  } else if (store === "secret-service") {
    const ok = run(
      "secret-tool",
      ["store", "--label=Master Mind agent key", "service", SERVICE, "account", apiUrl],
      key,
    ).ok;
    if (ok) return store;
  }
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  writeFileSync(fileStore(), JSON.stringify({ [apiUrl]: key }), { mode: 0o600 });
  chmodSync(fileStore(), 0o600);
  return "file";
}

export function loadKey(apiUrl: string): { key: string; store: Store } | null {
  const env = process.env.MM_AGENT_KEY;
  if (env && KEY_RE.test(env)) return { key: env, store: "env" };
  const store = availableStore();
  if (store === "macos-keychain") {
    const r = run("security", ["find-generic-password", "-s", SERVICE, "-a", apiUrl, "-w"]);
    if (r.ok && KEY_RE.test(r.out)) return { key: r.out, store };
  } else if (store === "secret-service") {
    const r = run("secret-tool", ["lookup", "service", SERVICE, "account", apiUrl]);
    if (r.ok && KEY_RE.test(r.out)) return { key: r.out, store };
  }
  if (existsSync(fileStore())) {
    try {
      const key = (JSON.parse(readFileSync(fileStore(), "utf8")) as Record<string, string>)[apiUrl];
      if (key && KEY_RE.test(key)) return { key, store: "file" };
    } catch {
      return null;
    }
  }
  return null;
}

export function deleteKey(apiUrl: string): void {
  const store = availableStore();
  if (store === "macos-keychain")
    run("security", ["delete-generic-password", "-s", SERVICE, "-a", apiUrl]);
  if (store === "secret-service")
    run("secret-tool", ["clear", "service", SERVICE, "account", apiUrl]);
  rmSync(fileStore(), { force: true });
}
