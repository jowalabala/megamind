// Background worker: runs the ingest pipeline and queue maintenance.
import { createDb, databaseSslFromEnv, databaseUrlFromEnv, historyRepo } from "@mm/db";
import { createQueue } from "@mm/db/queue";
import {
  fileBronze,
  memberBronzePrefix,
  s3Bronze,
  startIngestWorkers,
  tenantRedactors,
} from "@mm/ingest";
import { localLake, processErasures, publishOutbox, type LakeAdmin, type LakeSink } from "@mm/lake";
import { athenaLake, firehoseSink } from "@mm/lake/aws";
import {
  createGithubApp,
  finalizeMetrics,
  runSzzSweep,
  startGithubWorkers,
  startPendingBackfills,
} from "@mm/github";
import { bedrockTransport, createLlm, dbCallLogger, modelConfigFromEnv } from "@mm/llm";
import {
  attributeTasks,
  tenantPackLoader,
  categorizeTask,
  judgeSweep,
  type CategorizeJob,
} from "@mm/packs";
import { finalizeSequenceOutcomes, hubspotConfigFromEnv, syncHubspot } from "@mm/hubspot";
import { measureSkills } from "@mm/skills";
import { sendNotifications } from "@mm/slack";
import { vaultFromEnv } from "@mm/vault";
import { expireChannels } from "@mm/collab";
import { comprehendDetector } from "@mm/privacy/comprehend";

const connectionString = databaseUrlFromEnv();
if (!connectionString)
  throw new Error("DATABASE_URL (or DATABASE_HOST/USER/PASSWORD) is required.");
const pseudonymSecret = process.env.MM_PSEUDONYM_SECRET;
if (!pseudonymSecret) throw new Error("MM_PSEUDONYM_SECRET is required (32+ characters).");
const ssl = databaseSslFromEnv();

const bucket = process.env.MM_BRONZE_BUCKET;
if (!bucket && process.env.NODE_ENV === "production") {
  throw new Error("MM_BRONZE_BUCKET is required in production.");
}
const bronze = bucket
  ? s3Bronze({ bucket, region: process.env.AWS_REGION })
  : fileBronze(process.env.MM_BRONZE_DIR ?? "../../.data/bronze");

// One JSON line per event. Ids and outcomes only, never content.
const log = (event: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));

const db = createDb({ connectionString, ssl, max: 10 });
const queue = await createQueue({
  connectionString,
  ssl,
  supervise: true,
  onError: (err) => log("queue.error", { message: err.message }),
});
const redactorFor = tenantRedactors({
  db,
  pseudonymSecret,
  external:
    process.env.MM_PII_COMPREHEND === "on"
      ? comprehendDetector({ region: process.env.AWS_REGION })
      : undefined,
});

await startIngestWorkers(queue, { db, bronze, redactorFor, log });

// Categorization: pack rules first, Claude (Haiku on Bedrock) only when they don't decide.
const llm =
  process.env.MM_LLM_CATEGORIZE === "off"
    ? null
    : createLlm({
        transport: bedrockTransport({ awsRegion: process.env.AWS_REGION }),
        models: modelConfigFromEnv(),
        log: dbCallLogger(db),
      });
// Built-in packs, with each tenant's own edited generic pack in place of the built-in one.
const packs = tenantPackLoader(db);
await queue.work<CategorizeJob>("categorize.task", async (job) => {
  const d = await categorizeTask({ db, packs, llm }, job.data);
  log("categorize.done", {
    tenantId: job.data.tenantId,
    taskId: job.data.taskId,
    category: d?.category ?? null,
    method: d?.method ?? null,
  });
});

// GitHub connector, when the App is configured.
const githubAppId = process.env.MM_GITHUB_APP_ID;
const githubKey = process.env.MM_GITHUB_PRIVATE_KEY?.replace(/\\n/g, "\n");
const githubDeps =
  githubAppId && githubKey
    ? {
        db,
        redactorFor,
        log,
        app: createGithubApp({
          appId: githubAppId,
          privateKey: githubKey,
          apiUrl: process.env.MM_GITHUB_API_URL,
        }),
        enqueue: async (
          name: "github.backfill_repo" | "github.sync_pr" | "categorize.task",
          data: object,
          options?: { id?: string; startAfter?: Date },
        ) => {
          await queue.send(name, data, options);
        },
      }
    : null;
if (githubDeps) await startGithubWorkers(queue, githubDeps);

// OAuth tokens (HubSpot, Slack) are sealed with KMS in AWS, a local key in development.
const vault = vaultFromEnv();
const webUrl = process.env.MM_WEB_URL ?? "http://localhost:3000";

// HubSpot connector, when the app is configured.
const hubspotConfig = hubspotConfigFromEnv();
const hubspotDeps =
  hubspotConfig && vault
    ? {
        db,
        vault,
        redactorFor,
        log,
        config: hubspotConfig,
        enqueue: async (name: "categorize.task", data: object, options?: { id?: string }) => {
          await queue.send(name, data, options);
        },
      }
    : null;

// The lake: Firehose + Athena in AWS, newline-delimited JSON files in development.
const stream = process.env.MM_LAKE_FIREHOSE_STREAM;
const tableBucketArn = process.env.MM_LAKE_TABLE_BUCKET_ARN;
if (process.env.NODE_ENV === "production" && (!stream || !tableBucketArn)) {
  throw new Error(
    "MM_LAKE_FIREHOSE_STREAM and MM_LAKE_TABLE_BUCKET_ARN are required in production.",
  );
}
let sink: LakeSink;
let lakeAdmin: LakeAdmin;
if (stream && tableBucketArn) {
  sink = firehoseSink({ streamName: stream, region: process.env.AWS_REGION, log });
  lakeAdmin = athenaLake({
    stage: process.env.MM_STAGE ?? "dev",
    region: process.env.AWS_REGION ?? "us-east-1",
    accountId: tableBucketArn.split(":")[4]!,
    tableBucketName: tableBucketArn.split("/").pop()!,
    log,
  });
} else {
  const local = localLake({ dir: process.env.MM_LAKE_DIR ?? "../../.data/lake" });
  sink = local;
  lakeAdmin = local;
}

/** Runs `fn` every `ms`, never overlapping itself, logging (not crashing on) failures. */
function every(name: string, ms: number, fn: () => Promise<unknown>) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      log(`${name}.error`, { message: (err as Error).message });
    } finally {
      running = false;
    }
  };
  void tick();
  return setInterval(tick, ms);
}

const timers = [
  every("lake.publish", 5_000, () =>
    publishOutbox({ db, sink, requireProvisioned: Boolean(stream), log }),
  ),
  every("erasure", 60_000, () =>
    processErasures({
      db,
      lake: lakeAdmin,
      requireProvisioned: Boolean(stream),
      deleteRaw: async (tenantId, memberId) => {
        await bronze.deletePrefix(memberBronzePrefix(tenantId, memberId));
      },
      log,
    }),
  ),
  ...(githubDeps
    ? [every("github.backfills", 30_000, () => startPendingBackfills(githubDeps))]
    : []),
  ...(hubspotDeps
    ? [
        every("hubspot.sync", 30 * 60_000, async () => {
          for (const t of await db.system.listTenantsForJobs()) {
            await syncHubspot(hubspotDeps, t.tenantId);
          }
        }),
      ]
    : []),
  // Outcomes: trace fixes (needs GitHub), finalize mature PR and sequence metrics, judge,
  // attribute agent tasks to what they produced, then measure the served skills.
  every("outcomes", 10 * 60_000, async () => {
    for (const t of await db.system.listTenantsForJobs()) {
      if (githubDeps) await runSzzSweep(githubDeps, t.tenantId);
      await finalizeMetrics({ db, log }, t.tenantId);
      if (hubspotDeps) await finalizeSequenceOutcomes(hubspotDeps, t.tenantId);
      await judgeSweep({ db, packs, log }, t.tenantId);
      await attributeTasks({ db }, t.tenantId);
      await measureSkills({ db, log }, t.tenantId);
    }
  }),
  // Notifications go out as Slack DMs where Slack is connected.
  every("notifications", 5_000, async () => {
    for (const t of await db.system.listTenantsForJobs()) {
      await sendNotifications(
        { db, vault, webUrl, slackBaseUrl: process.env.MM_SLACK_API_URL || undefined, log },
        t.tenantId,
      );
    }
  }),
  every("channels.expire", 60_000, async () => {
    for (const t of await db.system.listTenantsForJobs()) {
      const n = await db.withTenant(t.tenantId, (tx) => expireChannels(tx, t.tenantId));
      if (n) log("channels.expired", { tenantId: t.tenantId, channels: n });
    }
  }),
  every("hot.prune", 60 * 60_000, async () => {
    for (const t of await db.system.listTenantsForJobs()) {
      const n = await db.withTenant(t.tenantId, (tx) => historyRepo.pruneHotActions(tx, 90));
      if (n) log("hot.pruned", { tenantId: t.tenantId, actions: n });
    }
  }),
];

log("worker.started", {
  comprehend: process.env.MM_PII_COMPREHEND === "on",
  lake: stream ? "firehose" : "local",
  github: Boolean(githubDeps),
  hubspot: Boolean(hubspotDeps),
  vault: process.env.MM_VAULT_KMS_KEY_ID ? "kms" : vault ? "local" : "none",
  llm: Boolean(llm),
});

async function shutdown() {
  for (const t of timers) clearInterval(t);
  await queue.stop();
  await db.close();
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
