// Week 4 check: a fixture repository is backfilled into the lake and its PRs are categorized.
// Real Postgres, real job handlers, a fake GitHub API and a fake model.
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  connectionRepo,
  connections,
  createDb,
  eq,
  externalRefs,
  githubPullRequests,
  memberRepo,
  sql,
  tasks,
  type MasterMindDb,
} from "@mm/db";
import { adminQuery, startTestDatabase, type TestDatabase } from "@mm/db/testing";
import { tenantRedactors } from "@mm/ingest";
import { localLake, publishOutbox, type LocalLake } from "@mm/lake";
import type { Llm } from "@mm/llm";
import { builtinPacks, categorizeTask } from "@mm/packs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appJwt,
  backfillRepoPage,
  createGithubApp,
  planWebhook,
  prTaskId,
  startPendingBackfills,
  syncPr,
  verifySignature,
  type BackfillRepoJob,
  type GithubDeps,
  type SyncPrJob,
} from "../src/index.ts";
import {
  APP_ID,
  DANA,
  INSTALLATION_ID,
  LEAKED_TOKEN,
  PRIVATE_KEY,
  QUIET,
  SAM,
  startFakeGithub,
  type FakeGithub,
} from "./fixture.ts";

let env: TestDatabase;
let db: MasterMindDb;
let gh: FakeGithub;
let tenantId: string;
let connectionId: string;
let danaId: string;
let samId: string;
let lake: LocalLake;
const llmCalls: string[] = [];

type Job = { name: string; data: unknown; id?: string; startAfter?: Date };
const queued: Job[] = [];
let deps: GithubDeps;

/** Runs queued jobs (including ones they queue) until none are left. */
async function drain() {
  const seen = new Set<string>();
  for (let i = 0; i < 500 && queued.length; i++) {
    const job = queued.shift()!;
    if (job.id && seen.has(job.id)) continue;
    if (job.id) seen.add(job.id);
    if (job.startAfter && job.startAfter > new Date()) delayed.push(job);
    else if (job.name === "github.backfill_repo")
      await backfillRepoPage(deps, job.data as BackfillRepoJob);
    else if (job.name === "github.sync_pr") await syncPr(deps, job.data as SyncPrJob);
    else if (job.name === "categorize.task") {
      await categorizeTask(
        { db, packs: builtinPacks(), llm: fakeLlm },
        job.data as { tenantId: string; taskId: string },
      );
    }
  }
}
const delayed: Job[] = [];

const fakeLlm = {
  async run(_prompt: unknown, vars: { task: { title: string } }) {
    llmCalls.push(vars.task.title);
    return { category: /split/i.test(vars.task.title) ? "refactor" : "other", confidence: 0.95 };
  },
} as unknown as Llm;

async function prTask(number: number, repoId = 1001) {
  const [t] = await db.withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, prTaskId(tenantId, repoId, number))),
  );
  return t;
}

beforeAll(async () => {
  env = await startTestDatabase();
  db = createDb({ connectionString: env.appUrl, max: 4 });
  gh = await startFakeGithub();
  lake = localLake();
  const t = await db.system.provisionTenant({
    name: "Acme",
    slug: "acme",
    workosOrgId: "org_acme",
    admin: { workosUserId: "admin", email: "admin@acme.test", displayName: "Admin" },
  });
  tenantId = t.tenantId;
  await db.withTenant(tenantId, async (tx) => {
    const add = async (name: string, githubId: number, optOut = false) => {
      const { member } = await memberRepo.ensureMember(tx, tenantId, {
        workosUserId: `user_${randomUUID()}`,
        email: `${name}@acme.test`,
        displayName: name,
      });
      await tx.execute(sql`
        UPDATE members SET github_user_id = ${githubId}, capture_opt_out = ${optOut}
         WHERE id = ${member.id}`);
      return member.id;
    };
    danaId = await add("Dana Levi", DANA);
    await add("Quiet Person", QUIET, true);
    samId = (
      await memberRepo.ensureMember(tx, tenantId, {
        workosUserId: "user_sam",
        email: "sam@acme.test",
        displayName: "Sam Patel",
      })
    ).member.id;
    connectionId = (
      await connectionRepo.upsertGithubInstallation(tx, tenantId, {
        installationId: INSTALLATION_ID,
        accountLogin: "acme",
        createdByMemberId: t.adminMemberId,
      })
    ).connection.id;
  });
  deps = {
    db,
    app: createGithubApp({ appId: APP_ID, privateKey: PRIVATE_KEY, apiUrl: gh.url }),
    redactorFor: tenantRedactors({ db, pseudonymSecret: "p".repeat(40), ttlMs: 0 }),
    enqueue: async (name, data, options) => {
      queued.push({ name, data, id: options?.id, startAfter: options?.startAfter });
    },
  };
});

afterAll(async () => {
  await gh?.close();
  await db?.close();
  await env?.stop();
});

describe("week 4 check: backfill a fixture repository into the lake, categorized", () => {
  it("backfills every repository the installation can see, back to the window", async () => {
    expect(await startPendingBackfills(deps)).toBe(1);
    await drain();

    const [conn] = await db.withTenant(tenantId, (tx) => tx.select().from(connections));
    expect(conn!.backfillStatus).toBe("done");
    // The archived repository is skipped; 8 PRs stored in acme/api (not the opted-out
    // member's, not the one past the window), 1 in acme/web.
    expect(conn!.backfillState).toEqual({
      "1001": { name: "acme/api", done: true, prs: 8 },
      "1002": { name: "acme/web", done: true, prs: 1 },
    });
    const all = await db.withTenant(tenantId, (tx) =>
      tx.select().from(tasks).where(eq(tasks.source, "github")),
    );
    expect(all).toHaveLength(9);
    expect(await prTask(20)).toBeUndefined(); // opted-out author
    expect(await prTask(3)).toBeUndefined(); // before the window
    // GitHub's App JWT was accepted and every call used an installation token.
    expect(gh.calls.filter((c) => c.includes("access_tokens"))).toHaveLength(1);
  });

  it("links authors who linked their account, keys the rest by GitHub id, and redacts text", async () => {
    const t12 = await prTask(12);
    expect(t12).toMatchObject({ memberId: danaId, actorKey: `github:${DANA}` });
    const t16 = await prTask(16);
    expect(t16).toMatchObject({ memberId: null, actorKey: `github:${SAM}` });
    expect(t16!.summaryRedacted).toBe(
      "Reported by [EMAIL]. Repro used [SECRET:github_token] by mistake.",
    );
    expect(t16!.completedAt).not.toBeNull();
    const bump = await prTask(14);
    expect(bump!.actorKey).toBe("github:bot-dependabot");

    const { rows } = await adminQuery(
      env.adminUrl,
      `SELECT count(*)::int AS n FROM (
         SELECT summary_redacted AS t FROM tasks UNION ALL SELECT row::text FROM lake_outbox
         UNION ALL SELECT files::text FROM github_pull_requests) x WHERE t LIKE $1 OR t LIKE '%jane@%'`,
      [`%${LEAKED_TOKEN}%`],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("extracts PR features from metadata", async () => {
    const f = (await prTask(12))!.features;
    expect(f).toMatchObject({
      files_changed: 2,
      tests_touched: true,
      test_file_ratio: 0.5,
      docs_only: false,
      commits: 4,
      reviews: 2,
      reviewers: 1,
      changes_requested: 1,
      hours_to_first_review: 3,
      hours_to_merge: 20,
      has_linked_issue: true,
      agent_authored: true,
      ci_state: "SUCCESS",
    });
    expect((await prTask(15))!.features).toMatchObject({ docs_only: true, agent_authored: false });
    const [facts] = await db.withTenant(tenantId, (tx) =>
      tx.select().from(githubPullRequests).where(eq(githubPullRequests.number, 12)),
    );
    expect(facts).toMatchObject({ repo: "acme/api", state: "merged", closingIssues: [7] });
    const refs = await db.withTenant(tenantId, (tx) =>
      tx
        .select({ ref: externalRefs.ref })
        .from(externalRefs)
        .where(eq(externalRefs.taskId, facts!.taskId)),
    );
    expect(refs.map((r) => r.ref).sort()).toEqual([
      "github:issue:acme/api#7",
      "github:pr:acme/api#12",
    ]);
  });

  it("categorizes every PR: rules first, the model only for the one no rule covers", async () => {
    const got = Object.fromEntries(
      await Promise.all(
        [12, 13, 14, 15, 16, 17, 18, 19].map(async (n) => {
          const t = await prTask(n);
          return [n, `${t!.category}/${t!.categorySource}`];
        }),
      ),
    );
    expect(got).toEqual({
      12: "feature/rule",
      13: "revert/rule",
      14: "dependencies/rule",
      15: "docs/rule",
      16: "bugfix/rule",
      17: "refactor/llm",
      18: "ci/rule",
      19: "feature/rule",
    });
    expect((await prTask(5, 1002))!.category).toBe("bugfix");
    expect(llmCalls).toEqual(["Split the invoice module into smaller pieces"]);
    expect((await prTask(17))!).toMatchObject({ pack: "engineering", state: "categorized" });
  });

  it("publishes closed PRs and every categorization to the tenant's lake", async () => {
    await publishOutbox({ db, sink: lake });
    const rows = await lake.rows(tenantId, "tasks");
    // Closed or merged PRs only: #19 is still open.
    expect(rows).toHaveLength(8);
    const pr12 = rows.find((r) => r.event_id === prTaskId(tenantId, 1001, 12))!;
    expect(pr12).toMatchObject({
      source: "github",
      member_id: danaId,
      actor_key: `github:${DANA}`,
    });
    expect(JSON.parse(String(pr12.features))).toMatchObject({
      repo: "acme/api",
      agent_authored: true,
    });
    const cats = await lake.rows(tenantId, "task_categories");
    expect(cats).toHaveLength(9);
    expect(cats.find((c) => c.task_id === prTaskId(tenantId, 1001, 17))).toMatchObject({
      pack: "engineering",
      category: "refactor",
      method: "llm",
    });
  });
});

describe("live updates and re-runs", () => {
  it("a webhook for a merged PR re-syncs it, sends it to the lake and re-categorizes it", async () => {
    const draft = gh.data.repos[0]!.prs.find((p) => p.number === 19)!;
    Object.assign(draft, {
      state: "MERGED",
      isDraft: false,
      mergedAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const plan = planWebhook("pull_request", {
      action: "closed",
      installation: { id: Number(INSTALLATION_ID) },
      repository: { id: 1001, full_name: "Acme/API" },
      pull_request: { number: 19 },
    });
    expect(plan).toEqual({
      kind: "sync_prs",
      prs: [{ repoId: 1001, fullName: "Acme/API", number: 19 }],
    });
    await syncPr(deps, {
      tenantId,
      connectionId,
      installationId: INSTALLATION_ID,
      repoId: 1001,
      fullName: "Acme/API",
      number: 19,
    });
    await drain();
    await publishOutbox({ db, sink: lake });
    expect(await lake.rows(tenantId, "tasks")).toHaveLength(9);
    expect((await prTask(19))!.completedAt).not.toBeNull();
  });

  it("running the backfill again changes nothing and sends nothing twice", async () => {
    await db.withTenant(tenantId, (tx) =>
      tx.update(connections).set({ backfillStatus: "pending", backfillState: {} }),
    );
    await startPendingBackfills(deps);
    await drain();
    await publishOutbox({ db, sink: lake });
    const all = await db.withTenant(tenantId, (tx) =>
      tx.select().from(tasks).where(eq(tasks.source, "github")),
    );
    expect(all).toHaveLength(9);
    expect(await lake.rows(tenantId, "tasks")).toHaveLength(9);
  });

  it("waits out a rate limit instead of failing", async () => {
    gh.rateLimitNext = 1;
    delayed.length = 0;
    await syncPr(deps, {
      tenantId,
      connectionId,
      installationId: INSTALLATION_ID,
      repoId: 1001,
      fullName: "Acme/API",
      number: 12,
    });
    await drain();
    expect(delayed).toHaveLength(1);
    expect(delayed[0]!.startAfter!.getTime()).toBeGreaterThan(Date.now() + 5 * 60_000);
  });

  it("linking a GitHub account later claims that person's PRs", async () => {
    const res = await db.withTenant(tenantId, (tx) =>
      connectionRepo.linkGithubAccount(tx, samId, SAM),
    );
    expect(res.claimedTasks).toBe(1);
    expect((await prTask(16))!.memberId).toBe(samId);
  });
});

describe("App authentication and webhooks", () => {
  it("rejects a JWT signed with the wrong key", async () => {
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const app = createGithubApp({ appId: APP_ID, privateKey: other.privateKey, apiUrl: gh.url });
    await expect(
      app.installation(INSTALLATION_ID).rest("GET", "/installation/repositories"),
    ).rejects.toThrow(/401/);
    const [h, p] = appJwt(APP_ID, PRIVATE_KEY).split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(p!, "base64url").toString()).iss).toBe(APP_ID);
  });

  it("verifies webhook signatures in constant time", () => {
    const body = Buffer.from('{"zen":"Keep it logically awesome."}');
    const sig = `sha256=${createHmac("sha256", "whsec").update(body).digest("hex")}`;
    expect(verifySignature("whsec", body, sig)).toBe(true);
    expect(verifySignature("other", body, sig)).toBe(false);
    expect(verifySignature("whsec", Buffer.from(body.toString() + " "), sig)).toBe(false);
    expect(verifySignature("whsec", body, undefined)).toBe(false);
    expect(verifySignature("whsec", body, "sha1=abc")).toBe(false);
  });

  it("plans installation lifecycle and repository events", () => {
    expect(planWebhook("installation", { action: "deleted" })).toEqual({
      kind: "installation_status",
      status: "removed",
    });
    expect(
      planWebhook("installation_repositories", {
        action: "added",
        repositories_added: [{ id: 7, full_name: "acme/new" }],
      }),
    ).toEqual({ kind: "backfill_repos", repos: [{ id: 7, fullName: "acme/new" }] });
    expect(
      planWebhook("check_suite", {
        action: "completed",
        repository: { id: 1, full_name: "a/b" },
        check_suite: { pull_requests: [{ number: 3 }, { number: 4 }] },
      }),
    ).toMatchObject({ kind: "sync_prs", prs: [{ number: 3 }, { number: 4 }] });
    expect(planWebhook("push", {})).toMatchObject({ kind: "ignore" });
  });
});
