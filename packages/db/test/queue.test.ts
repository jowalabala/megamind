// The app role can send and work jobs, but can't change the queue schema.
import { afterAll, beforeAll, expect, it } from "vitest";
import { createQueue, QUEUES, type QueueClient } from "../src/queue.ts";
import { adminQuery, startTestDatabase, type TestDatabase } from "../src/testing.ts";

let env: TestDatabase;
let queue: QueueClient;
beforeAll(async () => {
  env = await startTestDatabase();
  queue = await createQueue({ connectionString: env.appUrl });
});
afterAll(async () => {
  await queue?.stop();
  await env?.stop();
});

it("installs every queue", async () => {
  const names = (await queue.boss.getQueues()).map((q) => q.name);
  expect(names).toEqual(expect.arrayContaining(Object.keys(QUEUES)));
});

it("mm_app sends and works jobs; a duplicate job id is ignored", async () => {
  const id = crypto.randomUUID();
  const seen: unknown[] = [];
  const done = new Promise<void>((resolve) => {
    void queue.work<{ n: number }>("ingest.task", async (job) => {
      seen.push(job.data);
      resolve();
    });
  });
  expect(await queue.send("ingest.task", { n: 1 }, { id })).toBe(id);
  expect(await queue.send("ingest.task", { n: 2 }, { id })).toBeNull();
  await done;
  expect(seen).toEqual([{ n: 1 }]);
});

it("mm_app owns nothing in the queue schema and can't create objects there", async () => {
  const { rows } = await adminQuery<{ owned: number; can_create: boolean }>(
    env.adminUrl,
    `SELECT (SELECT count(*)::int FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
             WHERE r.rolname = 'mm_app') AS owned,
            has_schema_privilege('mm_app', 'pgboss', 'CREATE') AS can_create`,
  );
  expect(rows[0]).toEqual({ owned: 0, can_create: false });
});
