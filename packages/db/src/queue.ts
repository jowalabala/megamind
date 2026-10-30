// Background job queue (pg-boss), in its own "pgboss" schema of the same Postgres.
//
// The schema and queues are installed by the migration role. The app role (mm_app) can
// send and work jobs but owns nothing and can't create objects. Job data must hold only
// ids and storage pointers, never captured content: the queue tables sit outside
// row-level security, so they are not a place for tenant data.
import { PgBoss, type ConstructorOptions, type Job, type SendOptions } from "pg-boss";
import pg from "pg";

export const QUEUE_SCHEMA = "pgboss";

/** Every queue, with its retry policy. Add new queues here; migrate() installs them. */
export const QUEUES = {
  "ingest.task": { retryLimit: 5, retryDelay: 5, retryBackoff: true, retryDelayMax: 300 },
  "ingest.outcome": { retryLimit: 8, retryDelay: 5, retryBackoff: true, retryDelayMax: 600 },
  "ingest.actions": { retryLimit: 5, retryDelay: 5, retryBackoff: true, retryDelayMax: 300 },
  "categorize.task": { retryLimit: 5, retryDelay: 10, retryBackoff: true, retryDelayMax: 600 },
  "github.sync_pr": { retryLimit: 6, retryDelay: 10, retryBackoff: true, retryDelayMax: 900 },
  "github.backfill_repo": {
    retryLimit: 6,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 1800,
  },
} as const satisfies Record<string, SendOptions>;

export type QueueName = keyof typeof QUEUES;

/** Installs or upgrades the queue schema and queues, then grants mm_app what it needs. Admin only. */
export async function installQueues(adminConnectionString: string): Promise<void> {
  const boss = new PgBoss({
    connectionString: adminConnectionString,
    schema: QUEUE_SCHEMA,
    migrate: true,
    createSchema: true,
    supervise: false,
    schedule: false,
    max: 2,
  });
  boss.on("error", () => {});
  await boss.start();
  try {
    const existing = new Set((await boss.getQueues()).map((q) => q.name));
    for (const [name, options] of Object.entries(QUEUES)) {
      if (existing.has(name)) await boss.updateQueue(name, options);
      else await boss.createQueue(name, options);
    }
  } finally {
    await boss.stop({ graceful: false, close: true });
  }
  const client = new pg.Client({ connectionString: adminConnectionString });
  await client.connect();
  try {
    await client.query(`
      GRANT USAGE ON SCHEMA ${QUEUE_SCHEMA} TO mm_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${QUEUE_SCHEMA} TO mm_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${QUEUE_SCHEMA} TO mm_app;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${QUEUE_SCHEMA} TO mm_app;`);
  } finally {
    await client.end();
  }
}

export interface QueueClient {
  send<N extends QueueName>(
    name: N,
    data: object,
    options?: { id?: string; startAfter?: Date },
  ): Promise<string | null>;
  work<T>(
    name: QueueName,
    handler: (job: Job<T>) => Promise<void>,
    options?: { concurrency?: number },
  ): Promise<void>;
  stop(): Promise<void>;
  /** For tests and health checks. */
  boss: PgBoss;
}

export interface CreateQueueOptions {
  /** mm_app connection string. */
  connectionString: string;
  /** Runs maintenance (expiry, retention). Exactly one kind of process should: the worker. */
  supervise?: boolean;
  max?: number;
  ssl?: ConstructorOptions["ssl"];
  onError?: (err: Error) => void;
}

export async function createQueue(options: CreateQueueOptions): Promise<QueueClient> {
  const boss = new PgBoss({
    connectionString: options.connectionString,
    schema: QUEUE_SCHEMA,
    // The app role never changes the schema; installQueues() does.
    migrate: false,
    createSchema: false,
    supervise: options.supervise ?? false,
    schedule: false,
    // Rebuilding indexes needs ownership, which mm_app deliberately lacks.
    reindex: false,
    max: options.max ?? 4,
    ssl: options.ssl,
  });
  boss.on("error", options.onError ?? ((err) => console.error("queue error:", err.message)));
  await boss.start();

  return {
    boss,
    async send(name, data, sendOptions) {
      return boss.send(name, data, { id: sendOptions?.id, startAfter: sendOptions?.startAfter });
    },
    async work(name, handler, workOptions) {
      // One job per handler call keeps retries and failures per job.
      await boss.work(
        name,
        {
          batchSize: 1,
          localConcurrency: workOptions?.concurrency ?? 2,
          pollingIntervalSeconds: 1,
        },
        async ([job]) => {
          if (job) await handler(job as Job<never>);
        },
      );
    },
    async stop() {
      await boss.stop({ graceful: true, close: true, timeout: 10_000 });
    },
  };
}
