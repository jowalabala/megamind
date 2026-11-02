// Week 10 check (docs/PLAN.md §10), the pack half: the full revenue pack judges HubSpot
// marketing emails and deals, and the generic pack judges work by metrics an admin defined,
// with outcomes from a CSV upload.
//
// Real: Postgres, the HubSpot connector, the categorizer and judge with per-tenant packs, the
// CSV import. Fake: HubSpot's HTTP API (from its documented shapes).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  connectionRepo,
  createDb,
  eq,
  judgments,
  memberRepo,
  packRepo,
  sql,
  tasks,
  type MasterMindDb,
  type TenantTx,
} from "@mm/db";
import { startTestDatabase, type TestDatabase } from "@mm/db/testing";
import { storeRefreshToken, syncHubspot, type HubspotDeps } from "@mm/hubspot";
import { tenantRedactors } from "@mm/ingest";
import {
  categorizeTask,
  editablePack,
  importOutcomes,
  judgeSweep,
  packToYaml,
  parseTenantPack,
  replayJudgments,
  tenantPackLoader,
} from "@mm/packs";
import { localVault } from "@mm/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DAY = 86_400_000;
const NOW = new Date();
const PSEUDO = "p".repeat(40);
const vault = localVault("v".repeat(40));
let env: TestDatabase;
let db: MasterMindDb;
let fake: Server;
let fakeUrl: string;
let tenantId: string;
let adminId: string;
const who: Record<string, string> = {};
const T = <R>(fn: (tx: TenantTx) => Promise<R>) => db.withTenant(tenantId, fn);

/** 16 newsletters, a week apart; click rates rise over time. The last one is the best. */
const EMAILS = Array.from({ length: 16 }, (_, i) => ({
  id: String(5001 + i),
  name: i === 3 ? "Webinar invite: closing faster" : `Monthly newsletter #${i + 1}`,
  publishedAt: new Date(NOW.getTime() - (130 - i * 7) * DAY),
  delivered: 1000,
  clicks: i === 15 ? 90 : i === 14 ? 2 : 20 + i,
  unsubscribed: i === 14 ? 30 : 3,
}));
/** Dana's deals: 6 won, 4 lost, 1 still open, 1 owned by someone who isn't a member. */
const DEALS = [
  ...Array.from({ length: 10 }, (_, i) => ({
    id: String(9001 + i),
    name: `Acme deal ${i + 1}`,
    owner: "77",
    type: i < 7 ? "newbusiness" : "existingbusiness",
    created: new Date(NOW.getTime() - (90 - i * 5) * DAY),
    closed: new Date(NOW.getTime() - (60 - i * 5) * DAY),
    won: i % 5 !== 1 && i % 5 !== 3,
  })),
  {
    id: "9011",
    name: "Open deal",
    owner: "77",
    type: "newbusiness",
    created: new Date(NOW.getTime() - 5 * DAY),
    closed: null,
    won: false,
  },
  {
    id: "9012",
    name: "Their deal",
    owner: "78",
    type: "newbusiness",
    created: new Date(NOW.getTime() - 50 * DAY),
    closed: new Date(NOW.getTime() - 20 * DAY),
    won: true,
  },
];

function fakeHubspot(): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    let text = "";
    for await (const c of req) text += c;
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    const p = url.pathname;
    if (p === "/oauth/v1/token") {
      return json(200, { access_token: "hs-access", refresh_token: "rt", expires_in: 1800 });
    }
    if (req.headers.authorization !== "Bearer hs-access") return json(401, {});
    if (p === "/crm/v3/owners") {
      return json(200, {
        results: [
          { id: "77", userId: 501, email: "dana@acme.test" },
          { id: "78", userId: 502, email: "partner@elsewhere.test" },
        ],
      });
    }
    if (p.startsWith("/automation/v4/sequences")) return json(200, { results: [] });
    if (p === "/marketing/v3/emails") {
      expect(url.searchParams.get("includeStats")).toBe("true");
      return json(200, {
        total: EMAILS.length,
        results: EMAILS.map((e) => ({
          id: e.id,
          name: e.name,
          state: "PUBLISHED",
          type: "BATCH_EMAIL",
          isPublished: true,
          publishedAt: e.publishedAt.toISOString(),
          publishedById: 501,
          stats: {
            counters: {
              sent: e.delivered + 10,
              delivered: e.delivered,
              open: 400,
              click: e.clicks,
              unsubscribed: e.unsubscribed,
            },
            ratios: {},
            deviceBreakdown: {},
            qualifierStats: {},
          },
        })),
      });
    }
    if (p === "/crm/v3/objects/deals") {
      const props = url.searchParams.get("properties")!.split(",");
      // Amounts and company data are never asked for.
      expect(props).not.toContain("amount");
      return json(200, {
        results: DEALS.map((d) => ({
          id: d.id,
          properties: {
            dealname: d.name,
            dealstage: d.closed ? (d.won ? "closedwon" : "closedlost") : "qualifiedtobuy",
            pipeline: "default",
            dealtype: d.type,
            createdate: d.created.toISOString(),
            closedate: d.closed?.toISOString() ?? null,
            hs_is_closed: String(Boolean(d.closed)),
            hs_is_closed_won: String(d.won),
            hubspot_owner_id: d.owner,
          },
        })),
      });
    }
    json(404, { error: "unknown", path: p, body: text.slice(0, 0) });
  });
}

beforeAll(async () => {
  fake = fakeHubspot();
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  env = await startTestDatabase();
  db = createDb({ connectionString: env.appUrl, max: 5 });
  const t = await db.system.provisionTenant({
    name: "Acme",
    slug: "acme",
    workosOrgId: "org_acme",
    admin: { workosUserId: "admin", email: "admin@acme.test", displayName: "Admin" },
  });
  tenantId = t.tenantId;
  adminId = t.adminMemberId;
  for (const name of ["dana", "lior", "noa"]) {
    who[name] = await T(async (tx) => {
      const { member } = await memberRepo.ensureMember(tx, tenantId, {
        workosUserId: `u_${name}`,
        email: `${name}@acme.test`,
        displayName: name,
      });
      return member.id;
    });
  }
  // Noa opted out: nothing of hers may be stored, from any source.
  await T((tx) => memberRepo.setCaptureOptOut(tx, who.noa!, true));
});

afterAll(async () => {
  await db?.close();
  await env?.stop();
  fake?.close();
});

const packs = () => tenantPackLoader(db, { ttlMs: 0 });
const redactorFor = () => tenantRedactors({ db, pseudonymSecret: PSEUDO, ttlMs: 0 });

async function categorizeAll() {
  const open = await T((tx) =>
    tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(sql`${tasks.category} IS NULL`),
  );
  for (const t of open) {
    await categorizeTask({ db, packs: packs(), llm: null }, { tenantId, taskId: t.id });
  }
}

const verdicts = async (where: ReturnType<typeof sql>) =>
  Object.fromEntries(
    (
      await T((tx) =>
        tx.execute<{ title: string; verdict: string; category: string }>(sql`
          SELECT t.title_redacted AS title, j.verdict, j.category FROM judgments j
            JOIN tasks t ON t.tenant_id = j.tenant_id AND t.id = j.task_id WHERE ${where}`),
      )
    ).rows.map((r) => [r.title, r]),
  );

describe("the revenue pack judges marketing emails and deals", () => {
  it("imports, categorizes and judges them, counts only", async () => {
    const conn = await T(
      async (tx) =>
        (
          await connectionRepo.upsertConnection(tx, tenantId, {
            provider: "hubspot",
            externalId: "999",
            accountLogin: null,
            createdByMemberId: adminId,
          })
        ).connection,
    );
    await storeRefreshToken({ db, vault }, tenantId, conn.id, "rt");
    const deps: HubspotDeps = {
      db,
      vault,
      redactorFor: redactorFor(),
      config: { clientId: "c", clientSecret: "s", redirectUri: "https://x/cb", apiUrl: fakeUrl },
      enqueue: async () => {},
      now: () => NOW,
    };
    expect(await syncHubspot(deps, tenantId)).toBe(EMAILS.length + DEALS.length);
    // A second sync changes nothing.
    await syncHubspot(deps, tenantId);
    expect(
      (await T((tx) => tx.select().from(tasks).where(eq(tasks.source, "hubspot")))).length,
    ).toBe(EMAILS.length + DEALS.length);

    await categorizeAll();
    const cats = await T((tx) =>
      tx.execute<{ category: string; n: number }>(sql`
        SELECT category, count(*)::int AS n FROM tasks WHERE source = 'hubspot' GROUP BY 1`),
    );
    expect(Object.fromEntries(cats.rows.map((r) => [r.category, r.n]))).toEqual({
      newsletter: 15,
      event_email: 1,
      new_business_deal: 9,
      expansion_deal: 3,
    });

    await judgeSweep({ db, packs: packs() }, tenantId);
    const emails = await verdicts(sql`j.category IN ('newsletter', 'event_email')`);
    // Only emails a week old with enough deliveries have final metrics: all 16 here.
    expect(Object.keys(emails)).toHaveLength(16);
    // The first ten have no history to compare with.
    expect(emails["Monthly newsletter #1"]!.verdict).toBe("inconclusive");
    // The best click rate is a success; the worst (and most unsubscribes) a failure.
    expect(emails["Monthly newsletter #16"]!.verdict).toBe("success");
    expect(emails["Monthly newsletter #15"]!.verdict).toBe("failure");

    const deals = await verdicts(sql`j.category LIKE '%deal'`);
    expect(Object.keys(deals)).toHaveLength(11); // the open deal isn't judged yet
    expect(deals["Acme deal 1"]!.verdict).toBe("success");
    expect(deals["Acme deal 2"]!.verdict).toBe("failure");
    expect(deals["Open deal"]).toBeUndefined();
    // A deal whose owner isn't a member is kept under their HubSpot identity, not credited.
    const theirs = await T((tx) =>
      tx
        .select()
        .from(tasks)
        .where(sql`${tasks.titleRedacted} = 'Their deal'`),
    );
    expect(theirs[0]).toMatchObject({ memberId: null, actorKey: "hubspot:502" });

    // Every judgment names revenue pack version 2, and replays identically.
    expect(
      (await T((tx) => tx.select().from(judgments))).every(
        (j) => j.pack === "revenue" && j.rulesetVersion === 2,
      ),
    ).toBe(true);
    expect((await replayJudgments({ db, packs: packs() }, tenantId)).mismatches).toEqual([]);

    // Only counts were stored for emails.
    const stored = await T((tx) =>
      tx.execute<{ counts: Record<string, unknown> }>(
        sql`SELECT counts FROM hubspot_marketing_emails`,
      ),
    );
    expect(Object.keys(stored.rows[0]!.counts).sort()).toEqual(
      ["as_of", "clicked", "delivered", "opened", "sent", "unsubscribed"].sort(),
    );
  });
});

describe("the generic pack judges work by an admin's own metrics, from a CSV", () => {
  const csv = (rows: string[]) =>
    ["ref,metric,value,title,owner_email,completed_at", ...rows].join("\r\n") + "\r\n";

  it("an admin defines a category, a metric and rules; a CSV upload is judged by them", async () => {
    // What the Metrics page does: edit the latest pack, validate it, store a new version.
    const { pack, version } = await editablePack(db, tenantId, "generic");
    expect(version).toBe(0);
    pack.categories.unshift({
      id: "month_end_close",
      name: "Month-end close",
      description: "Closing the books for a month",
      rules: [{ title: "(close|month-end)" }],
    });
    pack.metrics.push({
      id: "close.days_late",
      description: "Days late",
      unit: "count",
      better: "lower",
    });
    pack.judge = {
      version: 1,
      requires: ["close.days_late"],
      skip_categories: [],
      failure_if_any: [{ metric: "close.days_late", op: "gt", value: 2 }],
      success_if_all: [{ metric: "close.days_late", op: "lte", value: 0 }],
      baseline: { days: 180, min_samples: 20 },
    };
    const v1 = parseTenantPack(packToYaml(pack), 1);
    await T((tx) =>
      packRepo.savePackVersion(tx, tenantId, {
        packId: "generic",
        yaml: v1.yaml,
        expectedVersion: 0,
        memberId: adminId,
      }),
    );
    // A tenant pack can't take over a connector's work.
    expect(() =>
      parseTenantPack(
        packToYaml({ ...pack, applies_to: { ...pack.applies_to, sources: ["github"] } }),
        2,
      ),
    ).toThrow(/github has its own pack/);

    const months = ["January", "February", "March", "April"];
    const upload = csv([
      ...months.map(
        (m, i) =>
          `fin:close:${i + 1},close.days_late,${i},${m} close,${i % 2 ? "lior" : "dana"}@acme.test,2026-0${i + 1}-05`,
      ),
      'fin:close:9,close.days_late,1,"Close, with ""quotes""",dana@acme.test,2026-06-05',
      "fin:close:5,unknown.metric,1,May close,dana@acme.test,2026-05-05",
      "fin:close:6,close.days_late,1,June close,noa@acme.test,2026-06-05",
      "fin:close:7,close.days_late,1,July close,nobody@acme.test,2026-07-05",
      "fin:close:8,close.days_late,soon,Aug close,dana@acme.test,2026-08-05",
      "fin:close:10,close.days_late,1,,,",
    ]);
    const res = await importOutcomes(
      { db, packs: packs(), redactorFor: redactorFor(), now: () => NOW },
      tenantId,
      adminId,
      upload,
    );
    expect(res).toMatchObject({ rows: 10, stored: 5, createdTasks: 5 });
    expect(res.problems.map((p) => p.line)).toEqual([7, 8, 9, 10, 11]);
    expect(res.problems.find((p) => p.line === 8)!.problem).toMatch(/opted out/);
    // Problems never echo what was in the cells.
    expect(JSON.stringify(res.problems)).not.toMatch(/nobody@|soon|unknown\.metric|June/);
    // The same file again stores nothing new.
    expect(
      (
        await importOutcomes(
          { db, packs: packs(), redactorFor: redactorFor(), now: () => NOW },
          tenantId,
          adminId,
          upload,
        )
      ).stored,
    ).toBe(0);
    // Nothing for the opted-out member.
    expect(await T((tx) => tx.select().from(tasks).where(eq(tasks.memberId, who.noa!)))).toEqual(
      [],
    );

    await judgeSweep({ db, packs: packs() }, tenantId);
    const closes = await verdicts(sql`j.pack = 'generic'`);
    expect(Object.values(closes).every((v) => v.category === "month_end_close")).toBe(true);
    expect(closes["January close"]!.verdict).toBe("success");
    expect(closes["February close"]!.verdict).toBe("neutral");
    expect(closes["April close"]!.verdict).toBe("failure");

    // An agent can attach a later result to the same work by its ref.
    const later = await importOutcomes(
      { db, packs: packs(), redactorFor: redactorFor(), now: () => NOW },
      tenantId,
      adminId,
      "ref,metric,value,observed_at\nfin:close:2,close.days_late,0,2026-03-01\n",
    );
    expect(later).toMatchObject({ stored: 1, createdTasks: 0 });

    // A second edit is a new ruleset version; earlier judgments keep theirs and still replay.
    const { pack: p2, version: at } = await editablePack(db, tenantId, "generic");
    expect(at).toBe(1);
    p2.judge!.success_if_all = [{ metric: "close.days_late", op: "lte", value: 1 }];
    await T((tx) =>
      packRepo.savePackVersion(tx, tenantId, {
        packId: "generic",
        yaml: parseTenantPack(packToYaml(p2), 2).yaml,
        expectedVersion: 1,
        memberId: adminId,
      }),
    );
    await expect(
      T((tx) =>
        packRepo.savePackVersion(tx, tenantId, {
          packId: "generic",
          yaml: v1.yaml,
          expectedVersion: 1,
          memberId: adminId,
        }),
      ),
    ).rejects.toThrow(/while you were editing/);
    await judgeSweep({ db, packs: packs() }, tenantId);
    const versions = await T((tx) =>
      tx.execute<{ v: number; n: number }>(sql`
        SELECT ruleset_version AS v, count(*)::int AS n FROM judgments WHERE pack = 'generic' GROUP BY 1 ORDER BY 1`),
    );
    expect(versions.rows).toEqual([
      { v: 1, n: 5 },
      { v: 2, n: 5 },
    ]);
    expect((await replayJudgments({ db, packs: packs() }, tenantId)).mismatches).toEqual([]);
  });
});
