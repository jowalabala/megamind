# Master Mind

Company-wide AI brain: captures what teams and their agents do, learns which practices
produce results, and turns them into reviewed, versioned skills. See [docs/PLAN.md](docs/PLAN.md).

## Layout

| Path             | What                                                            |
| ---------------- | --------------------------------------------------------------- |
| `apps/web`       | Next.js app: sign-in (WorkOS), onboarding, members, dashboard   |
| `packages/db`    | Postgres schema (SQL migrations), RLS, tenant-scoped client     |
| `packages/audit` | Append-only, hash-chained audit log                             |
| `packages/llm`   | Claude on Bedrock: prompt registry, structured output, call log |
| `infra`          | AWS CDK: network, data (RDS, S3, KMS), app (ECS Fargate)        |
| `docs/adr`       | Architecture decisions                                          |

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

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test
```

`pnpm test` starts throwaway Postgres containers (Testcontainers), so Docker must be running.

## Conventions

- All tenant data access goes through `db.withTenant(tenantId, tx => ...)`. Never import `pg` directly.
- Every state change that matters gets an audit event in the **same transaction** (`appendAuditEvent`).
- Migrations are append-only SQL files in `packages/db/migrations`; the Drizzle schema mirrors them
  (a test fails if they drift).
- LLM calls go through `@mm/llm` with a versioned prompt; captured content is wrapped with `untrusted()`.
