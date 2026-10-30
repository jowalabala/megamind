// Real-time gateway entrypoint.
import { createDb, databaseSslFromEnv, databaseUrlFromEnv } from "@mm/db";
import { tenantRedactors } from "@mm/ingest";
import { createGateway } from "./gateway.ts";

const connectionString = databaseUrlFromEnv();
if (!connectionString)
  throw new Error("DATABASE_URL (or DATABASE_HOST/USER/PASSWORD) is required.");
const secret = process.env.MM_GATEWAY_SECRET;
if (!secret)
  throw new Error("MM_GATEWAY_SECRET is required (32+ characters, shared with the API).");
const pseudonymSecret = process.env.MM_PSEUDONYM_SECRET;
if (!pseudonymSecret) throw new Error("MM_PSEUDONYM_SECRET is required.");
const ssl = databaseSslFromEnv();

const log = (event: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));

const db = createDb({ connectionString, ssl, max: 10 });
const gateway = await createGateway({
  db,
  listenUrl: connectionString,
  ssl,
  secret,
  redactorFor: tenantRedactors({ db, pseudonymSecret }),
  log,
});
const port = Number(process.env.PORT ?? 4200);
const host = process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
gateway.server.listen(port, host, () => log("gateway.started", { port }));

async function shutdown() {
  await gateway.close();
  await db.close();
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
