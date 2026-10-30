# Master Mind

Company-wide AI brain: captures what teams and their agents do, learns which practices
produce results, and turns them into reviewed, versioned skills. See [docs/PLAN.md](docs/PLAN.md).

## Layout

| Path               | What                                                                   |
| ------------------ | ---------------------------------------------------------------------- |
| `apps/web`         | Next.js app: sign-in (WorkOS), onboarding, members, agents, privacy    |
| `apps/api`         | Fastify: remote MCP (`/mcp`) and REST (`/v1/*`) for agents             |
| `apps/worker`      | Background jobs: the ingest pipeline                                   |
| `packages/db`      | Postgres schema (SQL migrations), RLS, tenant-scoped client, job queue |
| `packages/audit`   | Append-only, hash-chained audit log                                    |
| `packages/privacy` | PII and secret redaction, with a labelled test corpus                  |
| `packages/ingest`  | Capture: input schemas, bronze storage, accept and process steps       |
| `packages/mcp`     | MCP tool definitions shared by the remote server and the bridge        |
| `packages/llm`     | Claude on Bedrock: prompt registry, structured output, call log        |
| `infra`            | AWS CDK: network, data (RDS, S3, KMS), app (ECS Fargate)               |
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

### How capture flows

Agent → `log_task` (MCP) → API checks the key and the member's opt-out, stores the raw payload in
bronze (S3, KMS-encrypted, deleted after 30 days) and queues a pointer → worker re-checks opt-out,
redacts secrets and personal data, and writes the task to Postgres. See
[ADR 0002](docs/adr/0002-capture-pipeline.md).

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

## Conventions

- All tenant data access goes through `db.withTenant(tenantId, tx => ...)`. Never import `pg` directly.
- Every state change that matters gets an audit event in the **same transaction** (`appendAuditEvent`).
- Migrations are append-only SQL files in `packages/db/migrations`; the Drizzle schema mirrors them
  (a test fails if they drift).
- LLM calls go through `@mm/llm` with a versioned prompt; captured content is wrapped with `untrusted()`.
- Captured text is stored only after `@mm/privacy` redaction, in columns ending in `_redacted`.
- Queue jobs carry ids and storage pointers only, never captured content.
