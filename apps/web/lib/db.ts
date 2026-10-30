import { createDb, databaseSslFromEnv, databaseUrlFromEnv, type MasterMindDb } from "@mm/db";

// One pool per server process (survives hot reloads in dev).
const g = globalThis as unknown as { __mmDb?: MasterMindDb };

export function db(): MasterMindDb {
  if (!g.__mmDb) {
    const connectionString = databaseUrlFromEnv();
    if (!connectionString) throw new Error("Database connection settings are missing");
    g.__mmDb = createDb({ connectionString, ssl: databaseSslFromEnv() });
  }
  return g.__mmDb;
}
