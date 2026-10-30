// Week 5 check: outcome labels agree with a hand-labelled set of 50 PRs (>= 85%), and
// replaying the judge gives identical judgments. Real Postgres, real job code, a fake
// GitHub serving a labelled history with real diffs and blame.
import {
  compareLabels,
  buildReport,
  renderMarkdown,
  type HandLabel,
  parseLabelsCsv,
} from "@mm/backtest";
import {
  connectionRepo,
  createDb,
  eq,
  githubPrLinks,
  judgments,
  sql,
  type MasterMindDb,
} from "@mm/db";
import { adminQuery, startTestDatabase, type TestDatabase } from "@mm/db/testing";
import { tenantRedactors } from "@mm/ingest";
import { localLake, publishOutbox } from "@mm/lake";
import type { Llm } from "@mm/llm";
import { builtinPacks, categorizeTask, judge, judgeSweep, replayJudgments } from "@mm/packs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  backfillRepoPage,
  changedOldLines,
  createGithubApp,
  finalizeMetrics,
  parseReverts,
  prTaskId,
  runSzzSweep,
  startPendingBackfills,
  type BackfillRepoJob,
  type GithubDeps,
} from "../src/index.ts";
import {
  APP_ID,
  INSTALLATION_ID,
  PRIVATE_KEY,
  startFakeGithub,
  type FakeGithub,
} from "./fixture.ts";
import { BILLING_REPO, buildHistory } from "./history.ts";

let env: TestDatabase;
let db: MasterMindDb;
let gh: FakeGithub;
let tenantId: string;
let deps: GithubDeps;
const history = buildHistory();
const packs = builtinPacks();
const lake = localLake();
const queued: { name: string; data: unknown }[] = [];

// Titles no rule covers ("Undo ledger rounding change") go to the model; here it says "other".
const llm = { run: async () => ({ category: "other", confidence: 0.6 }) } as unknown as Llm;

async function drain() {
  for (let i = 0; i < 2000 && queued.length; i++) {
    const job = queued.shift()!;
    if (job.name === "github.backfill_repo")
      await backfillRepoPage(deps, job.data as BackfillRepoJob);
    else if (job.name === "categorize.task") {
      await categorizeTask({ db, packs, llm }, job.data as { tenantId: string; taskId: string });
    }
  }
}

/** The background sweeps, run until nothing is left to do. */
async function sweep() {
  while ((await runSzzSweep(deps, tenantId)) > 0);
  while ((await finalizeMetrics(deps, tenantId)) > 0);
  while ((await judgeSweep({ db, packs }, tenantId)) > 0);
}

beforeAll(async () => {
  env = await startTestDatabase();
  db = createDb({ connectionString: env.appUrl, max: 4 });
  gh = await startFakeGithub(
    10,
    { repos: [history.repo] },
    { files: history.files, blame: history.blame },
  );
  const t = await db.system.provisionTenant({
    name: "Acme",
    slug: "acme",
    workosOrgId: "org_acme",
    admin: { workosUserId: "admin", email: "admin@acme.test", displayName: null },
  });
  tenantId = t.tenantId;
  await db.withTenant(tenantId, (tx) =>
    connectionRepo.upsertGithubInstallation(tx, tenantId, {
      installationId: INSTALLATION_ID,
      accountLogin: "acme",
      createdByMemberId: t.adminMemberId,
    }),
  );
  deps = {
    db,
    app: createGithubApp({ appId: APP_ID, privateKey: PRIVATE_KEY, apiUrl: gh.url }),
    redactorFor: tenantRedactors({ db, pseudonymSecret: "p".repeat(40), ttlMs: 0 }),
    enqueue: async (name, data) => void queued.push({ name, data }),
  };
  await startPendingBackfills(deps);
  await drain();
  await sweep();
});

afterAll(async () => {
  await gh?.close();
  await db?.close();
  await env?.stop();
});

/** The "hand labels": ground truth for the first 50 judged PRs. */
async function handLabels(): Promise<HandLabel[]> {
  const judged = await db.withTenant(tenantId, (tx) =>
    tx.execute<{ number: number; category: string; baseline: Record<string, never> }>(sql`
      SELECT p.number, j.category, j.baseline FROM judgments j
        JOIN github_pull_requests p ON p.task_id = j.task_id ORDER BY p.number`),
  );
  const config = packs.find((p) => p.id === "engineering")!.judge!;
  return judged.rows.slice(0, 50).map((r) => {
    const t = history.truth.get(r.number)!;
    const pr = history.repo.prs.find((p) => p.number === r.number)!;
    // A human would judge the true outcome by the same rules and the same team baseline.
    const truthMetrics = {
      "pr.reverted": Number(t.reverted),
      "pr.escaped_defect": Number(t.escapedDefect),
      "ci.first_pass": Number(t.ciFirstPass),
      "pr.review_rounds": pr.reviews!.nodes.length,
    };
    const verdict = judge(
      config,
      { category: r.category, metrics: truthMetrics },
      r.baseline,
    )!.verdict;
    return {
      repo: BILLING_REPO.full_name,
      number: r.number,
      reverted: t.reverted,
      escaped_defect: t.escapedDefect,
      ci_first_pass: t.ciFirstPass,
      verdict,
    };
  });
}

describe("signals", () => {
  it("parses reverts and the lines a diff changes", () => {
    expect(parseReverts("Reverts acme/billing#16\n\nAlso reverts #3", "acme/billing")).toEqual({
      prs: [16, 3],
      shas: [],
    });
    expect(parseReverts(`This reverts commit ${"a".repeat(40)}.`, "a/b").shas).toEqual([
      "a".repeat(40),
    ]);
    const patch = [
      "@@ -10,3 +10,3 @@",
      " keep",
      "-  total += a;",
      "-",
      "-  // note",
      "+  total += b;",
      "@@ -40,0 +41,1 @@",
      "+ added",
    ].join("\n");
    // Line 11 is code; 12 is blank and 13 a comment, so they are not blamed.
    expect(changedOldLines(patch)).toEqual([11]);
  });

  it("traces fixes to the PRs that introduced the lines they changed", async () => {
    const links = await db.withTenant(tenantId, (tx) =>
      tx.select().from(githubPrLinks).where(eq(githubPrLinks.kind, "fixes")),
    );
    const pairs = new Set(
      await Promise.all(
        links.map(async (l) => {
          const n = async (id: string) => (await tx(id)).rows[0]!.number;
          return `${await n(l.fromTaskId)}->${await n(l.toTaskId)}`;
        }),
      ),
    );
    // #13 fixed #12; #22 fixed #21; #28 blames #27 (the refactor), not the true origin #26;
    // #20 is outside the window; #25 only added lines, so it traces to nothing.
    expect(pairs).toContain("13->12");
    expect(pairs).toContain("22->21");
    expect(pairs).toContain("28->27");
    expect([...pairs].some((p) => p.startsWith("20->") || p.startsWith("25->"))).toBe(false);
  });

  it("waits for maturity: the last 60 days are not finalized or judged", async () => {
    const recent = await db.withTenant(tenantId, (tx) =>
      tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM github_pull_requests
         WHERE number IN (90, 91, 92) AND metrics_final_at IS NULL`),
    );
    expect(recent.rows[0]!.n).toBe(3);
  });
});

async function tx(taskId: string) {
  return db.withTenant(tenantId, (t) =>
    t.execute<{ number: number }>(
      sql`SELECT number FROM github_pull_requests WHERE task_id = ${taskId}`,
    ),
  );
}

describe("week 5 check", () => {
  it("labels agree with 50 hand-labelled PRs at least 85% of the time", async () => {
    const labels = await handLabels();
    expect(labels).toHaveLength(50);
    // Round-trip through the CSV the pilot will use.
    const csv = [
      "repo,number,reverted,escaped_defect,ci_first_pass,verdict",
      ...labels.map((l) =>
        [l.repo, l.number, l.reverted, l.escaped_defect, l.ci_first_pass, l.verdict].join(","),
      ),
    ].join("\n");
    const report = await compareLabels(db, tenantId, parseLabelsCsv(csv));
    expect(report.prs).toBe(50);
    expect(report.overall.rate!).toBeGreaterThanOrEqual(0.85);
    expect(report.perLabel.verdict.rate!).toBeGreaterThanOrEqual(0.85);
    // The built-in traps are the disagreements: the add-only fix (#24), the refactor that
    // took the blame (#26 missed, #27 wrongly flagged), the unannounced undo (#30).
    const wrong = new Set(report.disagreements.map((d) => `${d.number}:${d.label}`));
    expect(wrong).toContain("24:escaped_defect");
    expect(wrong).toContain("26:escaped_defect");
    expect(wrong).toContain("27:escaped_defect");
    expect(wrong).toContain("30:reverted");
    expect(report.perLabel.ci_first_pass.rate).toBe(1);
    console.log(
      `agreement: overall ${(report.overall.rate! * 100).toFixed(1)}% (${report.overall.agreed}/${report.overall.compared}), ` +
        Object.entries(report.perLabel)
          .map(([k, v]) => `${k} ${(v.rate! * 100).toFixed(0)}%`)
          .join(", "),
    );
  });

  it("replaying the judge gives identical judgments", async () => {
    const before = await db.withTenant(tenantId, (t) =>
      t
        .select({
          task: judgments.taskId,
          verdict: judgments.verdict,
          hash: judgments.inputHash,
          reasons: judgments.reasons,
        })
        .from(judgments),
    );
    expect(before.length).toBeGreaterThanOrEqual(50);
    expect(await replayJudgments({ db, packs }, tenantId)).toEqual({
      checked: before.length,
      mismatches: [],
    });

    // From scratch: drop every judgment and judge again.
    await adminQuery(env.adminUrl, "DELETE FROM judgments");
    while ((await judgeSweep({ db, packs }, tenantId)) > 0);
    const after = await db.withTenant(tenantId, (t) =>
      t
        .select({
          task: judgments.taskId,
          verdict: judgments.verdict,
          hash: judgments.inputHash,
          reasons: judgments.reasons,
        })
        .from(judgments),
    );
    const key = (rows: typeof before) => [...rows].sort((a, b) => a.task.localeCompare(b.task));
    expect(key(after)).toEqual(key(before));
  });

  it("judges against the team's own baseline, and says so when there isn't one yet", async () => {
    const rows = await db.withTenant(tenantId, (t) =>
      t.execute<{ number: number; verdict: string; baseline: Record<string, { n: number }> }>(sql`
        SELECT p.number, j.verdict, j.baseline FROM judgments j
          JOIN github_pull_requests p ON p.task_id = j.task_id ORDER BY p.merged_at`),
    );
    // The earliest PRs have under 20 earlier ones to compare with: nothing failed, so inconclusive.
    const first = rows.rows.find((r) => r.number === 10)!;
    expect(first.verdict).toBe("inconclusive");
    const later = rows.rows.at(-1)!;
    expect(later.baseline["pr.review_rounds"]!.n).toBeGreaterThanOrEqual(20);
    expect(rows.rows.find((r) => r.number === 12)!.verdict).toBe("failure");
    expect(rows.rows.find((r) => r.number === 16)!.verdict).toBe("failure");
    // Reverts, docs, chores and dependency bumps are not judged.
    for (const n of [17, 23, 32, 33]) expect(rows.rows.some((r) => r.number === n)).toBe(false);
  });
});

describe("backtest v0 from the lake", () => {
  it("reports outcomes per category with intervals, and the features that separate them", async () => {
    await publishOutbox({ db, sink: lake });
    // Early PRs are inconclusive (no baseline yet), so the training window needs enough history.
    const trainEnd = new Date(Date.now() - 100 * 86_400_000);
    const report = await buildReport(lake, tenantId, { trainEnd, minGroup: 3 });
    expect(report.judged).toBeGreaterThanOrEqual(50);
    const feature = report.categories.feature!;
    expect(feature.train.judged + feature.test.judged).toBeGreaterThan(10);
    expect(feature.train.success.low!).toBeLessThanOrEqual(feature.train.success.rate!);
    expect(feature.train.success.high!).toBeGreaterThanOrEqual(feature.train.success.rate!);
    expect(report.contrasts.length).toBeGreaterThan(0);
    const md = renderMarkdown(report);
    expect(md).toContain("| feature |");
    expect(md).toContain("Wilson");
    // Same lake, same report.
    expect(await buildReport(lake, tenantId, { trainEnd, minGroup: 3 })).toEqual(report);
    expect(prTaskId(tenantId, BILLING_REPO.id, 12)).toBeTruthy();
  });
});
