// Tenant deletion end to end: Postgres, raw payloads, the lake and connector tokens are all
// gone for the deleted tenant, and the other tenant keeps everything.
import { createServer, type Server } from "node:http";
import { appendAuditEvent } from "@mm/audit";
import {
  connectionRepo,
  createDb,
  memberRepo,
  tasks,
  tenantDeletionRepo,
  type MasterMindDb,
} from "@mm/db";
import { readTenantDeletion, tenantRowCounts } from "@mm/db/admin";
import { startTestDatabase, type TestDatabase } from "@mm/db/testing";
import { bronzeKey, memoryBronze } from "@mm/ingest";
import { localLake, taskRecord } from "@mm/lake";
import { localVault } from "@mm/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkRestoredDatabase,
  connectorRevoker,
  purgeTenant,
  PurgeNotAllowedError,
  renderRestoreReport,
} from "../src/index.ts";

const DAY = 86_400_000;
const vault = localVault("v".repeat(40));
let env: TestDatabase;
let db: MasterMindDb;
let fake: Server;
let fakeUrl: string;
const revoked: string[] = [];
const lake = localLake();
const bronze = memoryBronze();

async function seed(slug: string) {
  const t = await db.system.provisionTenant({
    name: slug,
    slug,
    workosOrgId: `org_${slug}`,
    admin: { workosUserId: `u_${slug}`, email: `admin@${slug}.test`, displayName: null },
  });
  const taskId = crypto.randomUUID();
  await db.withTenant(t.tenantId, async (tx) => {
    const { member } = await memberRepo.ensureMember(tx, t.tenantId, {
      workosUserId: `u_${slug}_dev`,
      email: `dev@${slug}.test`,
      displayName: null,
    });
    await tx.insert(tasks).values({
      id: taskId,
      tenantId: t.tenantId,
      memberId: member.id,
      source: "mcp",
      titleRedacted: "Some work",
    });
    await appendAuditEvent(tx, t.tenantId, {
      actorType: "system",
      actorId: null,
      action: "test.seeded",
    });
    for (const provider of ["hubspot", "slack"] as const) {
      const { connection: conn } = await connectionRepo.upsertConnection(tx, t.tenantId, {
        provider,
        externalId: `${provider}-${slug}`,
        accountLogin: null,
        createdByMemberId: t.adminMemberId,
      });
      const kind = provider === "hubspot" ? "refresh_token" : "bot_token";
      const sealed = await vault.seal(
        t.tenantId,
        `${provider}:${conn.id}:${kind}`,
        `${slug}-${provider}-token`,
      );
      await connectionRepo.saveSecret(tx, t.tenantId, conn.id, kind, sealed);
    }
    await bronze.put(bronzeKey(t.tenantId, member.id, "task", taskId, new Date()), { raw: true });
    await lake.put(t.tenantId, [
      {
        id: 1,
        table: "tasks",
        eventId: taskId,
        row: taskRecord({
          id: taskId,
          tenantId: t.tenantId,
          memberId: member.id,
          agentId: null,
          source: "mcp",
          sessionId: null,
          private: false,
          title: "Some work",
          summary: "",
          categoryHint: null,
          externalRefs: [],
          features: {},
          startedAt: null,
          completedAt: null,
          createdAt: new Date(),
          ingestedAt: new Date(),
        }).row,
      },
    ]);
  });
  return t;
}

let A: Awaited<ReturnType<typeof seed>>;
let B: Awaited<ReturnType<typeof seed>>;

beforeAll(async () => {
  env = await startTestDatabase();
  db = createDb({ connectionString: env.appUrl });
  fake = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.method === "DELETE" && req.url?.startsWith("/hubspot/oauth/v1/refresh-tokens/")) {
      revoked.push(decodeURIComponent(req.url.split("/").pop()!));
      res.writeHead(204).end();
      return;
    }
    if (req.url === "/slack/auth.revoke") {
      revoked.push(String(req.headers.authorization).replace("Bearer ", ""));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, revoked: true }));
      return;
    }
    res.writeHead(404).end(body);
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  A = await seed("alpha");
  B = await seed("bravo");
}, 60_000);

afterAll(async () => {
  await db?.close();
  await env?.stop();
  fake?.close();
});

const deps = (force = false) => ({
  adminUrl: env.adminUrl,
  bronze,
  dropLake: (id: string) => lake.dropTenant(id),
  revokeConnectors: connectorRevoker({
    adminUrl: env.adminUrl,
    vault,
    hubspotApiUrl: `${fakeUrl}/hubspot`,
    slackApiUrl: `${fakeUrl}/slack`,
  }),
  deleteIdentityOrg: async (org: string) => void revoked.push(org),
  force,
});

describe("tenant purge", () => {
  it("refuses tenants without a scheduled deletion, and during the grace period", async () => {
    await expect(purgeTenant(deps(), B.tenantId)).rejects.toBeInstanceOf(PurgeNotAllowedError);
    await db.withTenant(B.tenantId, (tx) =>
      tenantDeletionRepo.scheduleDeletion(tx, {
        requestedByMemberId: B.adminMemberId,
        purgeAfter: new Date(Date.now() + 7 * DAY),
      }),
    );
    await expect(purgeTenant(deps(), B.tenantId)).rejects.toThrow(/grace period/);
  });

  it("purges everything of B, and nothing of A", async () => {
    const aRows = await tenantRowCounts(env.adminUrl, A.tenantId);
    const aLake = await lake.tableCounts(A.tenantId);
    const report = await purgeTenant(deps(true), B.tenantId);

    expect(report.connectorsRevoked).toBe(2);
    expect(revoked).toEqual(
      expect.arrayContaining(["bravo-hubspot-token", "bravo-slack-token", "org_bravo"]),
    );
    expect(revoked.some((r) => r.startsWith("alpha"))).toBe(false);
    expect(report.bronzeObjects).toBe(1);
    expect(
      Object.values(await tenantRowCounts(env.adminUrl, B.tenantId)).every((n) => n === 0),
    ).toBe(true);
    expect(Object.values(await lake.tableCounts(B.tenantId)).every((n) => n === 0)).toBe(true);
    expect([...bronze.objects.keys()].some((k) => k.includes(B.tenantId))).toBe(false);

    expect(await tenantRowCounts(env.adminUrl, A.tenantId)).toEqual(aRows);
    expect(await lake.tableCounts(A.tenantId)).toEqual(aLake);
    expect([...bronze.objects.keys()].some((k) => k.includes(A.tenantId))).toBe(true);

    const state = await readTenantDeletion(env.adminUrl, B.tenantId);
    expect(state?.status).toBe("purged");
    expect(Object.keys(state!.steps).sort()).toEqual(
      ["bronze", "connectors", "identity", "lake", "postgres", "verified"].sort(),
    );
    expect(await db.system.resolveTenantByWorkosOrg("org_bravo")).toBeNull();
  });

  it("won't run twice", async () => {
    await expect(purgeTenant(deps(true), B.tenantId)).rejects.toThrow(/already purged/);
  });
});

describe("restore drill checks", () => {
  it("checks migrations, audit chains and rows on a database", async () => {
    const check = await checkRestoredDatabase(env.adminUrl);
    expect(check).toMatchObject({ ok: true, tenants: 1, auditChainsOk: 1, auditChainsBroken: [] });
    expect(check.latestMigration).toMatch(/^0013_/);
    expect(check.rows.tasks).toBe(1);
    expect(
      renderRestoreReport(check, {
        restoreStarted: "2026-10-31T00:00:00Z",
        available: "2026-10-31T00:12:00Z",
        restoredTo: "2026-10-30T23:55:00Z",
        instance: "mm-restore-drill-test",
      }),
    ).toContain("Time to restore: 12.0 minutes");
  });
});
