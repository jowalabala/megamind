import { createDb, type MasterMindDb } from "@mm/db";

// One pool per server process (survives hot reloads in dev).
const g = globalThis as unknown as { __mmDb?: MasterMindDb };

/** DATABASE_URL locally; on ECS the parts come from Secrets Manager as separate variables. */
export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const { DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_USER, DATABASE_PASSWORD } = env;
  if (!DATABASE_HOST || !DATABASE_USER || !DATABASE_PASSWORD) return null;
  const url = new URL(
    `postgres://${DATABASE_HOST}:${DATABASE_PORT ?? "5432"}/${DATABASE_NAME ?? "mastermind"}`,
  );
  url.username = DATABASE_USER;
  url.password = DATABASE_PASSWORD;
  return url.toString();
}

export function db(): MasterMindDb {
  if (!g.__mmDb) {
    const connectionString = databaseUrl();
    if (!connectionString) throw new Error("Database connection settings are missing");
    g.__mmDb = createDb({
      connectionString,
      ssl: process.env.DATABASE_SSL === "require" ? { rejectUnauthorized: true } : undefined,
    });
  }
  return g.__mmDb;
}
