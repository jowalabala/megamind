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
});

async function shutdown() {
  for (const t of timers) clearInterval(t);
  await queue.stop();
  await db.close();
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
