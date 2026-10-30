import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  actionEvents,
  agentRepo,
  agentSessions,
  artifacts,
  createDb,
  eq,
  externalRefs,
  memberRepo,
  metricObservations,
  tasks,
  type AuthenticatedAgent,
  type MasterMindDb,
} from "@mm/db";
import { adminQuery, startTestDatabase, type TestDatabase } from "@mm/db/testing";
import {
  acceptActions,
  acceptOutcome,
  acceptTask,
  actionBatchInput,
  IngestForbiddenError,
  logTaskInput,
  memoryBronze,
  processActions,
  processOutcome,
  processTask,
  reportOutcomeInput,
  RetryLaterError,
  tenantRedactors,
  type IngestJob,
} from "../src/index.ts";

let env: TestDatabase;
let db: MasterMindDb;
let tenantId: string;
let dana: AuthenticatedAgent;
let lior: AuthenticatedAgent;
const bronze = memoryBronze();
const sent: { name: string; data: IngestJob; id?: string }[] = [];
const queue = {
  async send(name: string, data: object, options?: { id?: string }) {
    if (sent.some((s) => s.name === name && s.id === options?.id)) return null;
    sent.push({ name, data: data as IngestJob, id: options?.id });
    return options?.id ?? null;
  },
};
const accept = { queue, bronze };

// A fake key assembled at runtime, so no secret-shaped literal sits in the repo.
const GITHUB_TOKEN = "ghp_" + "Zx81Kq0pLm7Tn2Vb5Rc9Wd4Ye6Uf3Ig1Ho8J".slice(0, 36);

let process: Parameters<typeof processTask>[0];

async function agentFor(workosUserId: string, email: string, displayName: string) {
  return db.withTenant(tenantId, async (tx) => {
    const { member } = await memberRepo.ensureMember(tx, tenantId, {
      workosUserId,
      email,
      displayName,
    });
    const { key } = await agentRepo.createAgent(tx, tenantId, {
      memberId: member.id,
      name: "Claude Code",
      kind: "claude_code",
      createdByMemberId: member.id,
    });
    return key;
  });
}

const lastJob = () => sent.at(-1)!.data;

beforeAll(async () => {
  env = await startTestDatabase();
  db = createDb({ connectionString: env.appUrl, max: 2 });
  ({ tenantId } = await db.system.provisionTenant({
    name: "Acme",
    slug: "acme",
    workosOrgId: "org_acme",
    admin: { workosUserId: "user_admin", email: "admin@acme.test", displayName: null },
  }));
  dana = (await db.system.authenticateAgent(
    await agentFor("user_dana", "dana.levi@acme.test", "Dana Levi"),
  ))!;
  lior = (await db.system.authenticateAgent(
    await agentFor("user_lior", "lior@acme.test", "Lior Ben-David"),
  ))!;
  process = {
    db,
    bronze,
    redactorFor: tenantRedactors({ db, pseudonymSecret: "x".repeat(32), ttlMs: 0 }),
  };
});

afterAll(async () => {
  await db?.close();
  await env?.stop();
});

beforeEach(async () => {
  await adminQuery(env.adminUrl, "UPDATE members SET capture_opt_out = false");
  dana.captureOptOut = false;
});

describe("log_task", () => {
  it("stores the task with secrets, emails and member names removed", async () => {
    const input = logTaskInput.parse({
      title: "Fix proration for jane@customer.test",
      summary: `Rotated ${GITHUB_TOKEN}; paired with Lior Ben-David on invoice.ts`,
      category_hint: "bugfix",
      external_refs: ["github:pr:acme/api#482"],
      artifacts: [{ kind: "diff", content: `- token = "${GITHUB_TOKEN}"\n+ token = env.GH` }],
      session: { id: "cc-1", repo: "github.com/acme/api", branch: "dana/proration" },
    });
    const res = await acceptTask(accept, dana, input);
    expect(res).toMatchObject({ captured: true });
    const job = lastJob();
    // The queued job carries pointers only.
    expect(JSON.stringify(job)).not.toContain(GITHUB_TOKEN);
    expect(Object.keys(job).sort()).toEqual(["agentId", "bronzeKey", "id", "memberId", "tenantId"]);

    expect(await processTask(process, job)).toBe("stored");
    const [task] = await db.withTenant(tenantId, (tx) =>
      tx.select().from(tasks).where(eq(tasks.id, job.id)),
    );
    expect(task!.titleRedacted).toBe("Fix proration for [EMAIL]");
    expect(task!.summaryRedacted).toMatch(
      /^Rotated \[SECRET:github_token\]; paired with \[PERSON:[0-9a-f]{8}\] on invoice\.ts$/,
    );
    // Title, summary and the diff artifact together.
    expect(task!.redactionCounts).toEqual({
      "pii:email": 1,
      "secret:github_token": 2,
      "pii:person": 1,
    });
    expect(task!.agentSessionId).not.toBeNull();

    const stored = await db.withTenant(tenantId, async (tx) => ({
      arts: await tx.select().from(artifacts).where(eq(artifacts.taskId, job.id)),
      refs: await tx.select().from(externalRefs).where(eq(externalRefs.taskId, job.id)),
      sessions: await tx.select().from(agentSessions),
    }));
    expect(stored.arts[0]!.contentRedacted).not.toContain(GITHUB_TOKEN);
    expect(stored.refs.map((r) => r.ref)).toEqual(["github:pr:acme/api#482"]);
    // "dana/proration" isn't a full name, so the branch is kept as is.
    expect(stored.sessions[0]!.contextRedacted).toMatchObject({ branch: "dana/proration" });

    // Nothing in the database holds the raw secret.
    const { rows } = await adminQuery(
      env.adminUrl,
      `SELECT count(*)::int AS n FROM (
         SELECT title_redacted || summary_redacted AS t FROM tasks
         UNION ALL SELECT content_redacted FROM artifacts
         UNION ALL SELECT data::text FROM pgboss.job) x WHERE t LIKE $1`,
      [`%${GITHUB_TOKEN}%`],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("drops an opted-out member's task before storing anything", async () => {
    dana.captureOptOut = true;
    const before = { objects: bronze.objects.size, jobs: sent.length };
    const res = await acceptTask(accept, dana, logTaskInput.parse({ title: "secret project" }));
    expect(res).toEqual({ captured: false, reason: "capture_opt_out" });
    expect({ objects: bronze.objects.size, jobs: sent.length }).toEqual(before);
  });

  it("drops the task and deletes the raw payload if the member opts out before processing", async () => {
    await acceptTask(accept, dana, logTaskInput.parse({ title: "late opt-out" }));
    const job = lastJob();
    expect(bronze.objects.has(job.bronzeKey)).toBe(true);
    await adminQuery(env.adminUrl, "UPDATE members SET capture_opt_out = true WHERE id = $1", [
      dana.memberId,
    ]);
    expect(await processTask(process, job)).toBe("dropped_opt_out");
    expect(bronze.objects.has(job.bronzeKey)).toBe(false);
    const rows = await db.withTenant(tenantId, (tx) =>
      tx.select().from(tasks).where(eq(tasks.id, job.id)),
    );
    expect(rows).toHaveLength(0);
  });

  it("stores a retried task once (same idempotency key, same id)", async () => {
    const input = logTaskInput.parse({ title: "retry me", idempotency_key: "run-42" });
    const a = await acceptTask(accept, dana, input);
    const jobsAfterFirst = sent.length;
    const b = await acceptTask(accept, dana, input);
    expect(a).toEqual(b);
    expect(sent.length).toBe(jobsAfterFirst);
    // Even if a duplicate job did run, it would be a no-op.
    expect(await processTask(process, lastJob())).toBe("stored");
    expect(await processTask(process, lastJob())).toBe("duplicate");
    // The same key from a different member is a different task.
    const c = await acceptTask(accept, lior, input);
    expect(c).not.toEqual(a);
  });

  it("refuses agents without the capture scope", async () => {
    await expect(
      acceptTask(accept, { ...dana, scopes: ["skills:read"] }, logTaskInput.parse({ title: "x" })),
    ).rejects.toBeInstanceOf(IngestForbiddenError);
  });

  it("refuses a job whose pointer doesn't match its bronze envelope", async () => {
    await acceptTask(accept, dana, logTaskInput.parse({ title: "tamper" }));
    const job = { ...lastJob(), memberId: lior.memberId };
    await expect(processTask(process, job)).rejects.toThrow(/does not match/);
  });
});

describe("report_outcome", () => {
  it("waits for its task, then stores the metric once", async () => {
    const { id: taskId } = (await acceptTask(
      accept,
      dana,
      logTaskInput.parse({ title: "send sequence" }),
    )) as { id: string };
    const taskJob = lastJob();

    await acceptOutcome(
      accept,
      dana,
      reportOutcomeInput.parse({
        task_id: taskId,
        metric: "email.replied",
        value: 0.12,
        n: 400,
        note: "ask sam@x.test",
      }),
    );
    const outcomeJob = lastJob();
    await expect(processOutcome(process, outcomeJob)).rejects.toBeInstanceOf(RetryLaterError);

    await processTask(process, taskJob);
    expect(await processOutcome(process, outcomeJob)).toBe("stored");
    expect(await processOutcome(process, outcomeJob)).toBe("duplicate");
    const [obs] = await db.withTenant(tenantId, (tx) =>
      tx.select().from(metricObservations).where(eq(metricObservations.taskId, taskId)),
    );
    expect(obs).toMatchObject({
      metricKey: "email.replied",
      value: 0.12,
      n: 400,
      noteRedacted: "ask [EMAIL]",
    });
  });

  it("can't report on another member's task", async () => {
    const { id: taskId } = (await acceptTask(
      accept,
      dana,
      logTaskInput.parse({ title: "dana's task" }),
    )) as { id: string };
    await processTask(process, lastJob());
    await acceptOutcome(
      accept,
      lior,
      reportOutcomeInput.parse({ task_id: taskId, metric: "ci.first_pass", value: 1 }),
    );
    await expect(processOutcome(process, lastJob())).rejects.toBeInstanceOf(RetryLaterError);
  });
});

describe("actions", () => {
  it("stores redacted action events in the session, once", async () => {
    const input = actionBatchInput.parse({
      session: { id: "cc-actions", repo: "github.com/acme/api" },
      events: [
        {
          id: crypto.randomUUID(),
          kind: "command",
          summary: `curl -H "Authorization: Bearer ${GITHUB_TOKEN}" api.github.com`,
          occurred_at: new Date().toISOString(),
        },
        {
          id: crypto.randomUUID(),
          kind: "edit",
          summary: "Edited computeTotal",
          resources: ["git:github.com/acme/api:src/billing/invoice.ts#L40-90"],
          occurred_at: new Date().toISOString(),
          task_id: crypto.randomUUID(),
        },
      ],
    });
    await acceptActions(accept, dana, input);
    expect(await processActions(process, lastJob())).toBe("stored");
    expect(await processActions(process, lastJob())).toBe("duplicate");
    const rows = await db.withTenant(tenantId, (tx) =>
      tx.select().from(actionEvents).where(eq(actionEvents.memberId, dana.memberId)),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.summaryRedacted).join(" ")).not.toContain(GITHUB_TOKEN);
    const edit = rows.find((r) => r.kind === "edit")!;
    expect(edit.resources).toEqual(["git:github.com/acme/api:src/billing/invoice.ts#L40-90"]);
    // The unknown task id was dropped rather than failing the batch.
    expect(edit.taskId).toBeNull();
  });
});
