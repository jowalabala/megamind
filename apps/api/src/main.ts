import { createDb, databaseSslFromEnv, databaseUrlFromEnv } from "@mm/db";
import { createQueue } from "@mm/db/queue";
import { fileBronze, s3Bronze } from "@mm/ingest";
import { buildApp } from "./app.ts";

const connectionString = databaseUrlFromEnv();
if (!connectionString)
  throw new Error("DATABASE_URL (or DATABASE_HOST/USER/PASSWORD) is required.");
const ssl = databaseSslFromEnv();

const bucket = process.env.MM_BRONZE_BUCKET;
if (!bucket && process.env.NODE_ENV === "production") {
  throw new Error("MM_BRONZE_BUCKET is required in production.");
}
const bronze = bucket
  ? s3Bronze({ bucket, region: process.env.AWS_REGION })
  : fileBronze(process.env.MM_BRONZE_DIR ?? "../../.data/bronze");

const db = createDb({ connectionString, ssl, max: 10 });
const queue = await createQueue({ connectionString, ssl, supervise: false });
const app = await buildApp({
  db,
  queue,
  bronze,
  githubWebhookSecret: process.env.MM_GITHUB_WEBHOOK_SECRET || undefined,
  gatewaySecret: process.env.MM_GATEWAY_SECRET || undefined,
  gatewayUrl: process.env.MM_GATEWAY_URL || undefined,
  logger: { level: process.env.LOG_LEVEL ?? "info" },
});

const port = Number(process.env.PORT ?? 4000);
// In containers the API must listen on all interfaces; on a laptop, only on localhost.
const host = process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
await app.listen({ port, host });

async function shutdown() {
  await app.close();
  await queue.stop();
  await db.close();
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
