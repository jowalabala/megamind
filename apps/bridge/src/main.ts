// mm: the Master Mind local bridge.
import { ApiError, createApi } from "./api.ts";
import { logError, readConfig, VERSION, writeConfig } from "./config.ts";
import { availableStore, deleteKey, loadKey, saveKey } from "./credentials.ts";
import { HOOK_EVENTS, runHook, type HookName } from "./hooks.ts";
import { hooksInstalled, install, uninstall } from "./install.ts";
import { runMcpServer } from "./mcp.ts";
import { repoInfo } from "./git.ts";
import { runPresence } from "./presence.ts";
import { flush, pendingCount } from "./spool.ts";

const HELP = `mm ${VERSION} - Master Mind local bridge

  mm login [--api-url URL]   Store your agent key (from Settings > Agents) in the OS keychain
  mm install [--dry-run]     Add capture hooks to Claude Code and register the MCP server
  mm status                  Show what's configured and what's waiting to be sent
  mm flush                   Send captured actions now
  mm uninstall               Remove the hooks and the MCP server
  mm logout                  Delete the stored key

  mm mcp                     (run by Claude Code) local MCP server
  mm hook <event>            (run by Claude Code) capture hook`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads a line without echoing it (the key). Piped input works too: `pbpaste | mm login`. */
async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) return (await readStdin()).trim();
  process.stderr.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  return new Promise((done) => {
    process.stdin.on("data", function onData(buf: Buffer) {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stderr.write("\n");
          return done(value.trim());
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    });
  });
}

const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "hook": {
      const name = args[0] as HookName;
      if (!(name in HOOK_EVENTS)) return 0;
      let payload = {};
      try {
        payload = JSON.parse((await readStdin()) || "{}");
      } catch (err) {
        logError("hook stdin", err);
      }
      const out = await runHook(name, payload);
      if (out) process.stdout.write(out + "\n");
      return 0; // never fail the agent
    }
    case "mcp":
      await runMcpServer();
      return -1; // keep running
    case "presence": {
      // Started in the background by the SessionStart hook.
      const [sessionId, cwd] = args;
      const cfg = readConfig();
      const key = cfg && loadKey(cfg.apiUrl);
      if (!sessionId || !cfg || !key) return 0;
      const api = createApi(cfg.apiUrl, key.key);
      const info = repoInfo(cwd ?? process.cwd());
      await runPresence({
        sessionId,
        session: { repo: info?.repo, branch: info?.branch ?? undefined, tool: "claude_code" },
        getToken: async () => {
          const t = await api.post<{ token: string; gateway_url: string }>(
            "/v1/gateway/token",
            {},
            5_000,
          );
          return { token: t.token, gatewayUrl: t.gateway_url };
        },
        log: (m) => logError("presence", new Error(m)),
      });
      return 0;
    }
    case "login": {
      const apiUrl = flag(args, "--api-url") ?? readConfig()?.apiUrl ?? process.env.MM_API_URL;
      if (!apiUrl) {
        console.error("Pass --api-url (shown next to your key in Settings > Agents).");
        return 1;
      }
      const key = await promptHidden("Agent key: ");
      try {
        const me = await createApi(apiUrl, key).get<{ scopes: string[]; capture_opt_out: boolean }>(
          "/v1/whoami",
        );
        writeConfig({ apiUrl });
        const store = saveKey(apiUrl, key);
        console.log(
          store === "file"
            ? "Logged in. Key stored in a file only you can read (no OS keychain in use)."
            : `Logged in. Key stored in ${store}.`,
        );
        console.log(`Scopes: ${me.scopes.join(", ")}`);
        if (me.capture_opt_out)
          console.log("You have opted out of capture; nothing will be stored.");
        console.log("Next: mm install");
        return 0;
      } catch (err) {
        console.error(
          err instanceof ApiError
            ? `Login failed: ${err.message}`
            : `Login failed: ${(err as Error).message}`,
        );
        return 1;
      }
    }
    case "logout": {
      const cfg = readConfig();
      if (cfg) deleteKey(cfg.apiUrl);
      console.log("Key deleted.");
      return 0;
    }
    case "install":
      for (const line of install({
        dryRun: args.includes("--dry-run"),
        mcp: !args.includes("--no-mcp"),
      })) {
        console.log(line);
      }
      return 0;
    case "uninstall":
      for (const line of uninstall({ mcp: !args.includes("--no-mcp") })) console.log(line);
      return 0;
    case "flush": {
      const cfg = readConfig();
      const key = cfg && loadKey(cfg.apiUrl);
      if (!cfg || !key) {
        console.error("Not logged in. Run mm login.");
        return 1;
      }
      const r = await flush(createApi(cfg.apiUrl, key.key));
      console.log(`Sent ${r.sent} action(s); ${r.kept} still waiting.`);
      return r.kept ? 1 : 0;
    }
    case "status": {
      const cfg = readConfig();
      const key = cfg && loadKey(cfg.apiUrl);
      console.log(`API:       ${cfg?.apiUrl ?? "not set (mm login)"}`);
      console.log(
        `Key:       ${key ? `stored (${key.store})` : `missing; would use ${availableStore()}`}`,
      );
      console.log(`Hooks:     ${hooksInstalled() ? "installed" : "not installed (mm install)"}`);
      console.log(`Waiting:   ${pendingCount()} action(s)`);
      return 0;
    }
    case "--version":
    case "-v":
      console.log(VERSION);
      return 0;
    default:
      console.log(HELP);
      return cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err) => {
    logError("main", err);
    console.error((err as Error).message);
    process.exitCode = process.argv[2] === "hook" ? 0 : 1;
  },
);
