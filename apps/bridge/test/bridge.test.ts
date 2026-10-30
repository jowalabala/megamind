import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toActionEvent } from "../src/capture.ts";
import { normalizeRemote, repoInfo } from "../src/git.ts";
import { runHook } from "../src/hooks.ts";
import { planInstall } from "../src/install.ts";
import { createBridgeServer } from "../src/mcp.ts";
import { pendingCount } from "../src/spool.ts";

// Fake values assembled at runtime so nothing secret-shaped is committed.
const AGENT_KEY = "mm_test_" + "k".repeat(20) + "K".repeat(20);
const GH_TOKEN = "ghp_" + "Zx81Kq0pLm7Tn2Vb5Rc9Wd4Ye6Uf3Ig1Ho8J".slice(0, 36);

describe("normalizeRemote", () => {
  it.each([
    ["git@github.com:acme/api.git", "github.com/acme/api"],
    [`https://x-access-token:${GH_TOKEN}@github.com/Acme/API.git`, "github.com/acme/api"],
    ["ssh://git@gitlab.example.com:2222/team/svc.git", "gitlab.example.com/team/svc"],
    ["https://github.com/acme/api/", "github.com/acme/api"],
    ["not a url", null],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeRemote(input)).toBe(expected);
  });
});

describe("toActionEvent", () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "mm-repo-"));
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.test");
    git("config", "user.name", "t");
    git("remote", "add", "origin", `https://user:${GH_TOKEN}@github.com/acme/api.git`);
    writeFileSync(
      join(repo, "invoice.ts"),
      Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\n",
    );
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const lines = readFileSync(join(repo, "invoice.ts"), "utf8").split("\n");
    lines[9] = "changed 10";
    lines[10] = "changed 11";
    lines[39] = "changed 40";
    writeFileSync(join(repo, "invoice.ts"), lines.join("\n"));
    writeFileSync(join(repo, "new.ts"), "a\nb\nc\n");
  });

  it("names the repo without credentials and records changed line ranges", () => {
    const info = repoInfo(repo)!;
    expect(info.repo).toBe("github.com/acme/api");
    expect(info.branch).toBe("main");
    const e = toActionEvent(
      { tool_name: "Edit", cwd: repo, tool_input: { file_path: join(repo, "invoice.ts") } },
      info,
    )!;
    expect(e).toMatchObject({ kind: "edit", summary: "Edited invoice.ts" });
    expect(e.resources).toEqual([
      "git:github.com/acme/api:invoice.ts#L10-11",
      "git:github.com/acme/api:invoice.ts#L40-40",
    ]);
    const w = toActionEvent(
      { tool_name: "Write", cwd: repo, tool_input: { file_path: "new.ts" } },
      info,
    )!;
    expect(w.resources).toEqual(["git:github.com/acme/api:new.ts#L1-3"]);
  });

  it("strips secrets from commands and never names files outside the project", () => {
    const info = repoInfo(repo);
    const cmd = toActionEvent(
      {
        tool_name: "Bash",
        cwd: repo,
        tool_input: {
          command: `curl -H "Authorization: Bearer ${GH_TOKEN}"\n  https://api.github.com`,
        },
      },
      info,
    )!;
    expect(cmd.kind).toBe("command");
    expect(cmd.summary).not.toContain(GH_TOKEN);
    expect(cmd.summary).toContain("[SECRET:");
    const outside = toActionEvent(
      { tool_name: "Read", cwd: repo, tool_input: { file_path: "/Users/someone/.ssh/config" } },
      info,
    )!;
    expect(outside).toMatchObject({ summary: "Read a file outside the project", resources: [] });
  });

  it("keeps metadata only and skips bookkeeping and its own tools", () => {
    const grep = toActionEvent(
      { tool_name: "Grep", tool_input: { pattern: "password=hunter2" } },
      null,
    )!;
    expect(grep.summary).toBe("Searched the code");
    const fetch = toActionEvent(
      { tool_name: "WebFetch", tool_input: { url: "https://docs.example.com/a?token=x" } },
      null,
    )!;
    expect(fetch.summary).toBe("Fetched docs.example.com");
    expect(toActionEvent({ tool_name: "TodoWrite" }, null)).toBeNull();
    expect(toActionEvent({ tool_name: "mcp__master-mind__log_task" }, null)).toBeNull();
    expect(toActionEvent({ tool_name: "mcp__linear__create_issue" }, null)!.summary).toBe(
      "Used linear/create_issue",
    );
  });
});

describe("planInstall", () => {
  it("adds its hooks next to existing ones, and is idempotent", () => {
    const existing = {
      theme: "dark",
      hooks: {
        PostToolUse: [
          { matcher: "Edit", hooks: [{ type: "command" as const, command: "prettier --write" }] },
        ],
      },
    };
    const once = planInstall(existing, "mm");
    const twice = planInstall(once, "mm");
    expect(twice).toEqual(once);
    expect(once.theme).toBe("dark");
    expect(once.hooks!.PostToolUse).toEqual([
      existing.hooks.PostToolUse[0],
      { matcher: "*", hooks: [{ type: "command", command: "mm hook post-tool-use", timeout: 10 }] },
    ]);
    expect(Object.keys(once.hooks!).sort()).toEqual([
      "PostToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
    ]);
    // A new install path replaces the old one rather than adding a second set.
    const moved = planInstall(once, '"/usr/bin/node" "/opt/mm/dist/mm.js"');
    expect(moved.hooks!.Stop).toHaveLength(1);
    expect(moved.hooks!.Stop![0]!.hooks[0]!.command).toBe(
      '"/usr/bin/node" "/opt/mm/dist/mm.js" hook stop',
    );
  });
});

describe("hooks and MCP tools against the API", () => {
  let server: Server;
  const received: {
    path: string;
    headers: IncomingMessage["headers"];
    body: Record<string, unknown>;
  }[] = [];
  let failNext = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        if (failNext > 0) {
          failNext--;
          res.writeHead(503).end("{}");
          return;
        }
        const body = data ? (JSON.parse(data) as Record<string, unknown>) : {};
        received.push({ path: req.url!, headers: req.headers, body });
        res.writeHead(req.url === "/v1/history/search" ? 200 : 202, {
          "content-type": "application/json",
        });
        res.end(
          JSON.stringify(
            req.url === "/v1/history/search"
              ? {
                  items: [
                    {
                      type: "task",
                      id: "t1",
                      at: "2026-10-01T00:00:00.000Z",
                      who: "Dana Levi",
                      title: "Add proration",
                      summary: "Did it",
                      resources: ["github:pr:acme/api#12"],
                      task_id: "t1",
                      outcomes: [{ metric: "ci.first_pass", value: 1, n: 1 }],
                    },
                  ],
                }
              : { captured: true, id: "00000000-0000-4000-8000-000000000001" },
          ),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const home = mkdtempSync(join(tmpdir(), "mm-home-"));
    process.env.MM_HOME = home;
    process.env.MM_AGENT_KEY = AGENT_KEY;
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    );
  });
  afterAll(() => {
    server?.close();
    delete process.env.MM_HOME;
    delete process.env.MM_AGENT_KEY;
  });
  beforeEach(() => {
    received.length = 0;
  });

  it("SessionStart tells the agent about the tools", async () => {
    const out = JSON.parse((await runHook("session-start", { session_id: "s1" }))!);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("search_history");
  });

  it("PostToolUse spools events; Stop sends them, authenticated and tagged as the bridge", async () => {
    for (let i = 0; i < 3; i++) {
      await runHook("post-tool-use", {
        session_id: "s1",
        tool_name: "Bash",
        tool_input: { command: `echo ${i} ${GH_TOKEN}` },
      });
    }
    // The first event flushed at once (no flush yet); the rest wait for the next flush.
    await runHook("stop", { session_id: "s1" });
    const actions = received.filter((r) => r.path === "/v1/actions");
    const events = actions.flatMap((r) => r.body.events as { summary: string }[]);
    expect(events).toHaveLength(3);
    expect(JSON.stringify(events)).not.toContain(GH_TOKEN);
    expect(actions[0]!.headers.authorization).toBe(`Bearer ${AGENT_KEY}`);
    expect(actions[0]!.headers["x-mm-client"]).toMatch(/^mm-bridge\//);
    expect(actions[0]!.body.session).toMatchObject({ id: "s1", tool: "claude_code" });
    expect(pendingCount()).toBe(0);
  });

  it("keeps events while the API is down and sends them later", async () => {
    failNext = 1;
    await runHook("post-tool-use", { session_id: "s2", tool_name: "Read", tool_input: {} });
    await runHook("stop", { session_id: "s2" });
    expect(pendingCount()).toBeGreaterThanOrEqual(1);
    await runHook("stop", { session_id: "s2" });
    expect(pendingCount()).toBe(0);
    expect(received.some((r) => r.path === "/v1/actions")).toBe(true);
  });

  it("the local MCP server strips secrets before log_task leaves the machine", async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createBridgeServer();
    await server.connect(a);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(b);
    const r = await client.callTool({
      name: "log_task",
      arguments: { title: "Rotate token", summary: `Old token was ${GH_TOKEN}\n\nkept formatting` },
    });
    expect(r.isError).toBeFalsy();
    const sent = received.find((x) => x.path === "/v1/tasks")!.body;
    expect(sent.summary).toBe("Old token was [SECRET:github_token]\n\nkept formatting");

    const h = await client.callTool({ name: "search_history", arguments: { query: "proration" } });
    expect((h.content as { text: string }[])[0]!.text).toContain("Outcomes: ci.first_pass=1 (n=1)");
    await client.close();
  });
});
