// The SQL migrations are the source of truth. This fails if the Drizzle schema disagrees.
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { allTables } from "../src/schema.ts";
import { adminQuery, startTestDatabase, type TestDatabase } from "../src/testing.ts";

let env: TestDatabase;
beforeAll(async () => {
  env = await startTestDatabase();
});
afterAll(async () => {
  await env?.stop();
});

it("Drizzle tables and columns match the migrated database", async () => {
  const { rows } = await adminQuery<{
    table_name: string;
    column_name: string;
    is_nullable: string;
  }>(
    env.adminUrl,
    `SELECT table_name, column_name, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name <> 'schema_migrations'`,
  );
  const db = new Map<string, Map<string, boolean>>();
  for (const r of rows) {
    if (!db.has(r.table_name)) db.set(r.table_name, new Map());
    db.get(r.table_name)!.set(r.column_name, r.is_nullable === "NO");
  }

  const drizzleTables = new Set<string>();
  for (const table of Object.values(allTables)) {
    const cfg = getTableConfig(table);
    drizzleTables.add(cfg.name);
    const dbCols = db.get(cfg.name);
    expect(dbCols, `table ${cfg.name} missing in database`).toBeDefined();
    const drizzleCols = new Map(cfg.columns.map((c) => [c.name, c.notNull]));
    expect([...drizzleCols.keys()].sort(), `${cfg.name} columns`).toEqual(
      [...dbCols!.keys()].sort(),
    );
    for (const [col, notNull] of drizzleCols) {
      expect(notNull, `${cfg.name}.${col} NOT NULL`).toBe(dbCols!.get(col));
    }
  }
  expect([...db.keys()].sort(), "tables missing from the Drizzle schema").toEqual(
    [...drizzleTables].sort(),
  );
});

it("migrations are idempotent and refuse edits to applied files", async () => {
  const again = await migrate(env.adminUrl);
  expect(again.applied).toEqual([]);
  await adminQuery(
    env.adminUrl,
    "UPDATE schema_migrations SET checksum = 'x' WHERE name = '0001_roles_and_helpers.sql'",
  );
  await expect(migrate(env.adminUrl)).rejects.toThrow(/changed after it was applied/);
});
