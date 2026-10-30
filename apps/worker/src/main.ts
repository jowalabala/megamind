// Background worker: runs the ingest pipeline and queue maintenance.
import { createDb, databaseSslFromEnv, databaseUrlFromEnv } from "@mm/db";
import { createQueue } from "@mm/db/queue";
import { fileBronze, s3Bronze, startIngestWorkers, tenantRedactors } from "@mm/ingest";
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
log("worker.started", { comprehend: process.env.MM_PII_COMPREHEND === "on" });

async function shutdown() {
  await queue.stop();
  await db.close();
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
