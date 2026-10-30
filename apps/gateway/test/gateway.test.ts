// Week 6 check (presence): two bridges see each other. Two gateway instances, so the
// cross-instance path (LISTEN/NOTIFY) is what delivers it.
import type { AddressInfo } from "node:net";
import { agentRepo, createDb, memberRepo, sql, teams, type MasterMindDb } from "@mm/db";
import { startTestDatabase, type TestDatabase } from "@mm/db/testing";
import { tenantRedactors } from "@mm/ingest";
import {
  PROTOCOL,
  signGatewayToken,
  TOKEN_PROTOCOL_PREFIX,
  type PresenceEntry,
} from "@mm/realtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { files, presenceContext, requestStop, runPresence } from "@mm/bridge/presence";
import { readFileSync, existsSync } from "node:fs";
import { createGateway } from "../src/gateway.ts";

const SECRET = "s".repeat(48);
let env: TestDatabase;
let db: MasterMindDb;
let gwA: Awaited<ReturnType<typeof createGateway>>;
let gwB: Awaited<ReturnType<typeof createGateway>>;
let urlA: string;
let urlB: string;
let tenantId: string;
let otherTenant: string;
const who: Record<string, { tenantId: string; memberId: string; agentId: string }> = {};

async function person(
  tenant: string,
  name: string,
  opts: { team?: string; optOut?: boolean } = {},
) {
  who[name] = await db.withTenant(tenant, async (tx) => {
    const { member } = await memberRepo.ensureMember(tx, tenant, {
      workosUserId: `u_${name}`,
      email: `${name.toLowerCase()}@acme.test`,
      displayName: name,
    });
    // These people chose to show their name to teammates (the default is their team only).
    await tx.execute(sql`UPDATE members SET visibility_pref = 'name', capture_opt_out = ${opts.optOut ?? false}
                          WHERE id = ${member.id}`);
    if (opts.team) {
      const [t] = await tx
        .select()
        .from(teams)
        .where(sql`name = ${opts.team}`);
      const teamId =
        t?.id ??
        (await tx.insert(teams).values({ tenantId: tenant, name: opts.team }).returning())[0]!.id;
      await memberRepo.addMemberToTeam(tx, tenant, teamId, member.id);
    }
    const { agent } = await agentRepo.createAgent(tx, tenant, {
      memberId: member.id,
      name: "cc",
      kind: "claude_code",
      createdByMemberId: member.id,
    });
    return { tenantId: tenant, memberId: member.id, agentId: agent.id };
  });
}

/** A minimal bridge: Node's built-in WebSocket client, token offered as a subprotocol. */
class Client {
  ws: WebSocket;
  presence: PresenceEntry[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: (() => void)[] = [];
  constructor(url: string, name: string, token?: string) {
    const t = token ?? signGatewayToken(SECRET, who[name]!).token;
    this.ws = new WebSocket(`${url}/ws`, [PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${t}`]);
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { type: string; sessions?: PresenceEntry[] };
      if (m.type === "presence") this.presence = m.sessions!;
      this.waiters.splice(0).forEach((w) => w());
    };
    this.ws.onclose = (e) => {
      this.closed = { code: e.code, reason: e.reason };
      this.waiters.splice(0).forEach((w) => w());
    };
  }
  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("connect failed"));
    });
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  async until(pred: () => boolean, ms = 3_000) {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 100);
      });
    }
  }
  names() {
    return this.presence.map((p) => p.who).sort();
  }
}

beforeAll(async () => {
  env = await startTestDatabase();
  db = createDb({ connectionString: env.appUrl, max: 6 });
  tenantId = (
    await db.system.provisionTenant({
      name: "Acme",
      slug: "acme",
      workosOrgId: "org_acme",
      admin: { workosUserId: "admin", email: "admin@acme.test", displayName: null },
    })
  ).tenantId;
  otherTenant = (
    await db.system.provisionTenant({
      name: "Beta",
      slug: "beta",
      workosOrgId: "org_beta",
      admin: { workosUserId: "admin_b", email: "admin@beta.test", displayName: null },
    })
  ).tenantId;
  await person(tenantId, "Dana", { team: "Platform" });
  await person(tenantId, "Lior", { team: "Platform" });
  await person(tenantId, "Quiet", { team: "Platform", optOut: true });
  await person(otherTenant, "Bob");
  const make = async () => {
    const gw = await createGateway({
      db,
      listenUrl: env.appUrl,
      secret: SECRET,
      redactorFor: tenantRedactors({ db, pseudonymSecret: "p".repeat(40), ttlMs: 0 }),
      // Long sweep: anything seen within the test came through NOTIFY.
      sweepMs: 60_000,
    });
    await new Promise<void>((r) => gw.server.listen(0, "127.0.0.1", () => r()));
    return { gw, url: `ws://127.0.0.1:${(gw.server.address() as AddressInfo).port}` };
  };
  ({ gw: gwA, url: urlA } = await make());
  ({ gw: gwB, url: urlB } = await make());
});

afterAll(async () => {
  await gwA?.close();
  await gwB?.close();
  await db?.close();
  await env?.stop();
});

describe("week 6 check: two bridges see each other's presence", () => {
  it("across gateway instances, with names, repo and branch, and leaving is seen at once", async () => {
    const dana = new Client(urlA, "Dana");
    const lior = new Client(urlB, "Lior");
    await Promise.all([dana.open(), lior.open()]);
    dana.send({
      type: "hello",
      session: {
        id: "cc-dana",
        repo: "github.com/acme/api",
        branch: "proration",
        tool: "claude_code",
      },
    });
    await dana.until(() => dana.names().includes("you"));
    lior.send({
      type: "hello",
      session: { id: "cc-lior", repo: "github.com/acme/api", branch: "tax-lines", tool: "cursor" },
    });

    await dana.until(() => dana.names().includes("Lior"));
    await lior.until(() => lior.names().includes("Dana"));
    expect(dana.presence.find((p) => p.who === "Lior")).toMatchObject({
      you: false,
      tool: "cursor",
      repo: "github.com/acme/api",
      branch: "tax-lines",
    });

    lior.send({ type: "bye" });
    await dana.until(() => !dana.names().includes("Lior"));
    expect(dana.names()).toEqual(["you"]);
    dana.send({ type: "bye" });
    await dana.until(() => dana.closed !== null);
  });

  it("private sessions, opted-out members and other tenants stay invisible", async () => {
    const dana = new Client(urlA, "Dana");
    const lior = new Client(urlB, "Lior");
    const quiet = new Client(urlA, "Quiet");
    const bob = new Client(urlB, "Bob");
    await Promise.all([dana.open(), lior.open(), quiet.open(), bob.open()]);
    dana.send({ type: "hello", session: { id: "cc-dana-2" } });
    lior.send({ type: "hello", session: { id: "cc-lior-secret", private: true } });
    quiet.send({ type: "hello", session: { id: "cc-quiet" } });
    bob.send({ type: "hello", session: { id: "cc-bob" } });
    await quiet.until(() => quiet.closed !== null);
    expect(quiet.closed!.code).toBe(4003);
    await lior.until(() => lior.presence.some((p) => p.you));
    await bob.until(() => bob.presence.some((p) => p.you));
    await new Promise((r) => setTimeout(r, 300));
    expect(dana.names()).not.toContain("Lior");
    expect(dana.presence.every((p) => p.you)).toBe(true);
    expect(bob.names()).toEqual(["you"]);
    // Lior sees their own private session (and Dana).
    expect(lior.names()).toEqual(["Dana", "you"]);
    for (const c of [dana, lior, bob]) c.ws.close();
  });

  it("refuses bad tokens, foreign protocols, junk and floods", async () => {
    const forged = new Client(urlA, "Dana", "x.y");
    await expect(forged.open()).rejects.toThrow();
    const expired = signGatewayToken(SECRET, who.Dana!, Date.now() - 6 * 60_000).token;
    await expect(new Client(urlA, "Dana", expired).open()).rejects.toThrow();
    const otherSecret = signGatewayToken("o".repeat(48), who.Dana!).token;
    await expect(new Client(urlA, "Dana", otherSecret).open()).rejects.toThrow();

    const junk = new Client(urlA, "Dana");
    await junk.open();
    junk.ws.send("{not json");
    await junk.until(() => junk.closed !== null);
    expect(junk.closed!.code).toBe(4004);

    const flood = new Client(urlA, "Dana");
    await flood.open();
    flood.send({ type: "hello", session: { id: "cc-flood" } });
    for (let i = 0; i < 30; i++) flood.send({ type: "heartbeat" });
    await flood.until(() => flood.closed !== null);
    expect(flood.closed!.code).toBe(4008);
  });

  it("a revoked agent is disconnected", async () => {
    const c = new Client(urlA, "Lior");
    await c.open();
    // Revoked after the token was issued: the token alone would still be valid.
    await db.withTenant(tenantId, (tx) => agentRepo.revokeAgent(tx, who.Lior!.agentId));
    c.send({ type: "hello", session: { id: "cc-revoked" } });
    await c.until(() => c.closed !== null);
    expect(c.closed!.code).toBe(4001);
    expect(c.presence).toEqual([]);
  });
});

describe("two bridge presence processes", () => {
  beforeAll(async () => {
    await person(tenantId, "Maya", { team: "Platform" });
    await person(tenantId, "Noam", { team: "Platform" });
  });

  it("see each other through the gateway, tell their agent once, and leave cleanly", async () => {
    process.env.MM_HOME = mkdtempSync(join(tmpdir(), "mm-bridges-"));
    const bridge = (name: string, url: string, sessionId: string) =>
      runPresence({
        sessionId,
        session: {
          repo: "github.com/acme/api",
          branch: `${name.toLowerCase()}-work`,
          tool: "claude_code",
        },
        getToken: async () => ({
          token: signGatewayToken(SECRET, who[name]!).token,
          gatewayUrl: url,
        }),
        heartbeatMs: 200,
        checkMs: 50,
      });
    const read = (sessionId: string) => {
      const f = files(sessionId).presence;
      return existsSync(f)
        ? (JSON.parse(readFileSync(f, "utf8")) as { sessions: PresenceEntry[] }).sessions
        : [];
    };
    const until = async (pred: () => boolean) => {
      const end = Date.now() + 5_000;
      while (!pred()) {
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    const mayaDone = bridge("Maya", urlA, "bridge-maya");
    const noamDone = bridge("Noam", urlB, "bridge-noam");
    await until(() => read("bridge-maya").some((s) => s.who === "Noam"));
    await until(() => read("bridge-noam").some((s) => s.who === "Maya"));

    // The prompt hook tells Maya's agent once, then stays quiet until something changes.
    const first = presenceContext("bridge-maya");
    expect(first).toContain("Noam: claude_code in github.com/acme/api (branch noam-work)");
    expect(presenceContext("bridge-maya")).toBeNull();

    requestStop("bridge-noam");
    await noamDone;
    await until(() => !read("bridge-maya").some((s) => s.who === "Noam"));
    // The change is reported again (others from earlier tests may still be within their window).
    const after = presenceContext("bridge-maya");
    expect(after).not.toBeNull();
    expect(after).not.toContain("Noam");
    requestStop("bridge-maya");
    await mayaDone;
    expect(existsSync(files("bridge-maya").pid)).toBe(false);
    delete process.env.MM_HOME;
  });
});
