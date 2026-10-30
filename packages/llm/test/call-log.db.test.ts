import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, llmCalls, type MasterMindDb } from "@mm/db";
import { startTestDatabase, type TestDatabase } from "@mm/db/testing";
import { dbCallLogger } from "../src/index.ts";

let env: TestDatabase;
let db: MasterMindDb;
beforeAll(async () => {
  env = await startTestDatabase();
  db = createDb({ connectionString: env.appUrl });
});
afterAll(async () => {
  await db?.close();
  await env?.stop();
});

it("writes call records into the tenant's llm_calls table", async () => {
  const { tenantId } = await db.system.provisionTenant({
    name: "Acme",
    slug: "acme",
    workosOrgId: null,
    admin: { workosUserId: "u1", email: "a@acme.test", displayName: null },
  });
  await dbCallLogger(db)({
    tenantId,
    stage: "categorize",
    promptId: "test.categorize",
    promptVersion: 1,
    model: "anthropic.claude-haiku-5-5",
    status: "ok",
    errorCode: null,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    latencyMs: 120,
    costUsd: 0.000004,
    inputHash: "c".repeat(64),
  });
  const rows = await db.withTenant(tenantId, (tx) => tx.select().from(llmCalls));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "ok", costUsd: "0.000004", latencyMs: 120 });
});
