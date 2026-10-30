// Test-only helpers: an isolated, migrated Postgres database with a login-enabled mm_app.
//
// Default: a throwaway pgvector/pgvector:pg16 container (Testcontainers; what CI runs).
// Set TEST_DATABASE_ADMIN_URL to a superuser URL on an existing server instead, and each
// call gets its own fresh database there, dropped again on stop().
import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate } from "./migrate.ts";

export const TEST_APP_PASSWORD = "mm_app_test_password";

export interface TestDatabase {
  /** Superuser connection: migrations and tamper simulation only. */
  adminUrl: string;
  /** mm_app connection: what application code uses. */
  appUrl: string;
  stop(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const external = process.env.TEST_DATABASE_ADMIN_URL;
  let adminUrl: string;
  let cleanup: () => Promise<void>;

  if (external) {
    const name = `mm_test_${randomBytes(6).toString("hex")}`;
    await adminQuery(external, `CREATE DATABASE ${name}`);
    const u = new URL(external);
    u.pathname = `/${name}`;
    adminUrl = u.toString();
    cleanup = async () => {
      await adminQuery(external, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    };
  } else {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    adminUrl = container.getConnectionUri();
    cleanup = async () => void (await container.stop());
  }

  await migrate(adminUrl);
  await adminQuery(adminUrl, `ALTER ROLE mm_app LOGIN PASSWORD '${TEST_APP_PASSWORD}'`);
  const app = new URL(adminUrl);
  app.username = "mm_app";
  app.password = TEST_APP_PASSWORD;
  return { adminUrl, appUrl: app.toString(), stop: cleanup };
}

export async function adminQuery<R extends pg.QueryResultRow = pg.QueryResultRow>(
  adminUrl: string,
  text: string,
  values?: unknown[],
): Promise<pg.QueryResult<R>> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await client.query<R>(text, values);
  } finally {
    await client.end();
  }
}
