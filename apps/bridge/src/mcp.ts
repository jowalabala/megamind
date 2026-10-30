// `mm mcp`: a local stdio MCP server for Claude Code and other IDE agents. Same tools as
// the remote server; secrets are stripped here before anything is sent.
import {
  registerAwarenessTools,
  registerCaptureTools,
  registerHistoryTools,
  SERVER_INFO,
  SERVER_INSTRUCTIONS,
  ToolUserError,
  type CaptureResult,
  type SearchHistoryResult,
} from "@mm/mcp";
import type { OverlapAlert, PresenceEntry } from "@mm/realtime";
import { currentSession } from "./presence.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApiError, createApi, type Api } from "./api.ts";
import { stripSecrets } from "./capture.ts";
import { readConfig } from "./config.ts";
import { loadKey } from "./credentials.ts";

function connect(): Api {
  const cfg = readConfig();
  const key = cfg && loadKey(cfg.apiUrl);
  if (!cfg || !key) throw new ToolUserError("Master Mind isn't set up here. Run `mm login` first.");
  return createApi(cfg.apiUrl, key.key);
}

// The input schemas already cap lengths; this only removes secrets.
const keep = (s: string | undefined) => (s === undefined ? s : stripSecrets(s));

async function call<T>(fn: (api: Api) => Promise<T>): Promise<T> {
  try {
    return await fn(connect());
  } catch (err) {
    if (err instanceof ApiError && err.status < 500) throw new ToolUserError(err.message);
    throw err;
  }
}

type Accepted = { captured: boolean; id?: string; reason?: string };
const toCapture = (r: Accepted): CaptureResult =>
  r.captured ? { captured: true, id: r.id } : { captured: false, reason: r.reason };

export function createBridgeServer(): McpServer {
  const server = new McpServer(
    { ...SERVER_INFO, name: "master-mind-bridge" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerCaptureTools(server, {
    logTask: (input) =>
      call(async (api) =>
        toCapture(
          await api.post<Accepted>("/v1/tasks", {
            ...input,
            title: keep(input.title),
            summary: keep(input.summary),
            category_hint: keep(input.category_hint),
            artifacts: input.artifacts.map((a) => ({
              ...a,
              content: keep(a.content),
              uri: keep(a.uri),
            })),
          }),
        ),
      ),
    reportOutcome: (input) =>
      call(async (api) =>
        toCapture(await api.post<Accepted>("/v1/outcomes", { ...input, note: keep(input.note) })),
      ),
  });
  // This Claude Code session, found through its presence process (same working directory).
  const session = () => {
    const s = currentSession(process.cwd());
    if (!s)
      throw new ToolUserError(
        "No live Master Mind session here yet (the SessionStart hook starts one).",
      );
    return s;
  };
  registerAwarenessTools(server, {
    whatsHappening: () => call((api) => api.get<{ sessions: PresenceEntry[] }>("/v1/presence")),
    announceIntent: (input) =>
      call(async (api) => {
        const s = session();
        return toCapture(
          await api.post<Accepted>("/v1/intents", {
            description: stripSecrets(input.description),
            resources: input.resources,
            session: { id: s.sessionId, repo: s.repo, branch: s.branch, tool: "claude_code" },
          }),
        );
      }),
    checkOverlaps: () =>
      call((api) =>
        api.get<{ overlaps: OverlapAlert[] }>(
          `/v1/overlaps?session_id=${encodeURIComponent(session().sessionId)}`,
        ),
      ),
  });
  registerHistoryTools(server, {
    searchHistory: (input) =>
      call((api) => api.post<SearchHistoryResult>("/v1/history/search", input)),
  });
  return server;
}

export async function runMcpServer(): Promise<void> {
  await createBridgeServer().connect(new StdioServerTransport());
}
