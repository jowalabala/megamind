import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { installQueues } from "./queue.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
// Arbitrary constant: only one migrator runs at a time.
const MIGRATION_LOCK_ID = 727_001;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies pending SQL migrations in filename order, each in its own transaction, then
 * installs or upgrades the job queue schema. Must run as the owner (migration) role,
 * never as mm_app. Applied migrations are immutable: a changed checksum is an error.
 */
export async function migrate(adminConnectionString: string): Promise<MigrationResult> {
  const result = await migrateSql(adminConnectionString);
  await installQueues(adminConnectionString);
  return result;
}

async function migrateSql(adminConnectionString: string): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString: adminConnectionString });
  await client.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const { rows } = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations",
    );
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const sqlText = await readFile(MIGRATIONS_DIR + file, "utf8");
      const checksum = createHash("sha256").update(sqlText).digest("hex");
      const previous = applied.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} was changed after it was applied. Add a new migration instead.`,
          );
        }
        result.skipped.push(file);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sqlText);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
          file,
          checksum,
        ]);
        await client.query("COMMIT");
        result.applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    return result;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
    await client.end();
  }
}
