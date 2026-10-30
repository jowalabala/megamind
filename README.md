# Master Mind

Company-wide AI brain: captures what teams and their agents do, learns which practices
produce results, and turns them into reviewed, versioned skills. See [docs/PLAN.md](docs/PLAN.md).

## Layout

| Path               | What                                                                   |
| ------------------ | ---------------------------------------------------------------------- |
| `apps/web`         | Next.js app: sign-in (WorkOS), onboarding, members, agents, privacy    |
| `apps/api`         | Fastify: remote MCP (`/mcp`) and REST (`/v1/*`) for agents             |
| `apps/worker`      | Background jobs: ingest, lake publishing, erasure, hot-index pruning   |
| `apps/bridge`      | `mm` CLI: local MCP server + Claude Code hooks for automatic capture   |
| `packages/db`      | Postgres schema (SQL migrations), RLS, tenant-scoped client, job queue |
| `packages/audit`   | Append-only, hash-chained audit log                                    |
| `packages/privacy` | PII and secret redaction, with a labelled test corpus                  |
| `packages/ingest`  | Capture: input schemas, bronze storage, accept and process steps       |
| `packages/mcp`     | MCP tool definitions shared by the remote server and the bridge        |
| `packages/lake`    | Iceberg lake: outbox publisher, Athena queries, erasure, provisioning  |
| `packages/llm`     | Claude on Bedrock: prompt registry, structured output, call log        |
| `infra`            | AWS CDK: network, data (RDS, S3, KMS), lake (S3 Tables, Firehose), app |
| `docs/adr`         | Architecture decisions                                                 |

## Local setup

Needs Node 22+, pnpm 10, Docker.

```bash
pnpm install
```

```bash
cp .env.example apps/web/.env.local
```

```bash
docker compose up -d postgres
```

```bash
set -a; source apps/web/.env.local; set +a; pnpm db:seed
```

```bash
pnpm --filter @mm/web dev
```

Fill in the WorkOS keys in `apps/web/.env.local` first (WorkOS dashboard → API keys) and register
`http://localhost:3000/callback` as a redirect URI. Without them, the home page lists what's missing.

### API and worker

They read `.env.local` at the repo root (copy `.env.example`, and set `MM_PSEUDONYM_SECRET`).

```bash
pnpm dev:api
```

```bash
pnpm dev:worker
```

Agent keys are normally created in the web app (Settings → Agents). Before WorkOS is set up,
create a local one for the seeded `dev@acme.test` member:

```bash
set -a; source .env.local; set +a; pnpm --filter @mm/db dev:agent-key
```

Then connect Claude Code to the local API:

```bash
claude mcp add --transport http master-mind http://localhost:4000/mcp --header "Authorization: Bearer <key>"
```

### The bridge (automatic capture from Claude Code)

```bash
pnpm --filter @mm/bridge build
```

```bash
node apps/bridge/dist/mm.js login --api-url http://localhost:4000
```

```bash
node apps/bridge/dist/mm.js install
```

`login` checks the key and stores it in the macOS Keychain (or Linux Secret Service). `install` adds
hooks to `~/.claude/settings.json` (a backup is written first) and registers the `master-mind` MCP
server. From then on each tool call becomes a one-line action (tool, file and changed lines,
command), with secrets removed on your machine, and the agent can call `search_history`.
`mm status` shows what's set up; `mm uninstall` removes it.

### How capture flows

Agent → `log_task` (MCP) or a bridge hook → API checks the key and the member's opt-out, stores the
raw payload in bronze (S3, KMS-encrypted, deleted after 30 days) and queues a pointer → worker
re-checks opt-out, redacts secrets and personal data, and writes Postgres rows plus their lake copy
(outbox) in one transaction → the worker publishes the outbox to the lake every 5 seconds. See
[ADR 0002](docs/adr/0002-capture-pipeline.md) and [ADR 0003](docs/adr/0003-lake-and-bridge.md).

`search_history` reads Postgres (all tasks, 90 days of actions). Locally the lake is
newline-delimited JSON under `.data/lake/`; in AWS it is Iceberg tables in S3 Tables.

### Lake in AWS: onboarding a tenant

After `cdk deploy`, each tenant needs its own namespace, KMS key, query role and Athena workgroup.
Run this with operator credentials (AWS SSO, Lake Formation admin), using the `MasterMind-<stage>-Lake`
and `-App` stack outputs:

```bash
MM_STAGE=dev MM_LAKE_TABLE_BUCKET_ARN=... MM_LAKE_RESULTS_BUCKET=... MM_LAKE_FIREHOSE_ROLE_ARN=... MM_LAKE_PERMISSIONS_BOUNDARY_ARN=... MM_LAKE_TRUSTED_ROLE_ARNS=... DATABASE_ADMIN_URL=... pnpm --filter @mm/lake provision-tenant <tenant-id>
```

It is safe to re-run. Until it has run, the tenant's lake rows wait in the outbox. To check what
reached the lake (add your own role to `MM_LAKE_TRUSTED_ROLE_ARNS` first):

```bash
pnpm --filter @mm/lake check <tenant-id> src/billing/
```

### Removing a member

Settings → Members → Remove (admins). It removes them from the WorkOS organization, deletes their
Postgres data at once, and the worker deletes their raw payloads and lake rows (twice, 15 minutes
apart, to catch rows still in flight). Old Iceberg snapshots expire within 11 days.

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test
```

`pnpm test` starts throwaway Postgres containers (Testcontainers), so Docker must be running.
Without Docker, point the tests at any Postgres 16+ superuser URL and each test file gets its own
fresh database there:

```bash
TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm test
```

Roles are per server, so this sets `mm_app`'s password to the test one. If your dev database is on
the same server, reset it afterwards: `ALTER ROLE mm_app PASSWORD 'mm_app_dev_password';`.

## Conventions

- All tenant data access goes through `db.withTenant(tenantId, tx => ...)`. Never import `pg` directly.
- Every state change that matters gets an audit event in the **same transaction** (`appendAuditEvent`).
- Migrations are append-only SQL files in `packages/db/migrations`; the Drizzle schema mirrors them
  (a test fails if they drift).
- LLM calls go through `@mm/llm` with a versioned prompt; captured content is wrapped with `untrusted()`.
- Captured text is stored only after `@mm/privacy` redaction, in columns ending in `_redacted`.
- Queue jobs carry ids and storage pointers only, never captured content.
