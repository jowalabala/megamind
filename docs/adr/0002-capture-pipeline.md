# ADR 0002: Capture pipeline

**Status:** accepted, week 2

## Decision

Agents send work through the API (`/mcp` or `/v1/*`) with a per-agent key. The API does the
minimum an agent has to wait for, and a worker does the rest:

1. **API (accept).** Resolve the key to tenant, agent and member (`mm_authenticate_agent`). If the
   member opted out, return `captured: false` and store nothing. Otherwise write the raw payload
   to **bronze** (S3, KMS, 30-day expiry, keys partitioned by tenant), queue a job that holds only
   ids and the bronze key, and return the record id.
2. **Worker (process).** Load the payload, check it matches the job, re-check opt-out (and delete
   the raw payload if the member opted out meanwhile), redact, then write rows in one tenant-scoped
   transaction. Every step is idempotent, so queue retries are safe.

## Why

- **Opt-out before storage.** An opted-out member's data never reaches bronze, the queue or Postgres.
- **Redaction off the request path.** Comprehend adds latency and can fail; retries belong in a queue.
- **Bronze for reprocessing.** When redaction improves, the last 30 days can be re-run.
- **Ids from idempotency keys.** A retried `log_task` maps to the same task id, so the agent can
  report outcomes against it even before the worker has run.

## Key details

- **Agent keys:** `mm_live_` + 40 random base62 characters, stored only as a sha256 hash in
  `agent_keys`. That table's RLS is enabled but not forced (like `tenants`) so the definer function
  can look up a hash before any tenant context exists. The app role can insert and delete keys, but
  has no SELECT on `key_hash`.
- **Queue:** pg-boss in its own `pgboss` schema, installed by the migration role. Its tables are
  outside row-level security, so job data is limited to ids and pointers; tests check that no
  captured text reaches it.
- **Redaction layers:** secret rules, PII rules with validators (Luhn, mod-97), tenant directory
  pseudonyms (`[PERSON:xxxxxxxx]`, HMAC keyed per tenant), then optional Comprehend for names and
  addresses outside the directory. Comprehend only sees text after the first three layers ran.
- **Outcomes** can only be reported for the agent's own member's tasks.

## Known gaps

- The redaction corpus is hand-written; recall on real pilot data must be measured with a labelled
  sample in week 10.
- Passwords written in prose ("the password is hunter2") are not caught by the deterministic rules.
- Names of people outside the tenant directory are only removed when Comprehend is on (it is in AWS).
