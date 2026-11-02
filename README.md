# Master Mind

Company-wide AI brain: captures what teams and their agents do, learns which practices
produce results, and turns them into reviewed, versioned skills. See [docs/PLAN.md](docs/PLAN.md).

## Layout

| Path                 | What                                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| `apps/web`           | Next.js app: sign-in (WorkOS), onboarding, members, agents, privacy    |
| `apps/api`           | Fastify: remote MCP (`/mcp`) and REST (`/v1/*`) for agents             |
| `apps/worker`        | Background jobs: ingest, lake publishing, erasure, hot-index pruning   |
| `apps/bridge`        | `mm` CLI: local MCP server + Claude Code hooks for automatic capture   |
| `apps/gateway`       | WebSocket gateway: live presence and overlap alerts                    |
| `packages/db`        | Postgres schema (SQL migrations), RLS, tenant-scoped client, job queue |
| `packages/audit`     | Append-only, hash-chained audit log                                    |
| `packages/privacy`   | PII and secret redaction, with a labelled test corpus                  |
| `packages/ingest`    | Capture: input schemas, bronze storage, accept and process steps       |
| `packages/mcp`       | MCP tool definitions shared by the remote server and the bridge        |
| `packages/lake`      | Iceberg lake: outbox publisher, Athena queries, erasure, provisioning  |
| `packages/github`    | GitHub App connector: auth, backfill, webhooks, PR sync and features   |
| `packages/hubspot`   | HubSpot connector: sequences, marketing emails, deals (counts only)    |
| `packages/slack`     | Slack: notification DMs, channel approval buttons, request signatures  |
| `packages/vault`     | Seals OAuth tokens (KMS in AWS, AES-GCM locally)                       |
| `packages/packs`     | Domain packs (YAML), admin-edited packs, CSV outcomes, categorizer     |
| `packages/backtest`  | Pilot backtest: outcomes, skill lift with placebo, overlap replay      |
| `packages/skills`    | Cohorts, skill extraction, the quality gate, dedupe, prompt evals      |
| `packages/awareness` | Resource keys, overlap detection and alerts                            |
| `packages/collab`    | Channels: human-approved handshake, broker, leases, agreements         |
| `packages/realtime`  | Gateway protocol: token signing, message schemas                       |
| `packages/llm`       | Claude on Bedrock: prompt registry, structured output, call log        |
| `packages/ops`       | Operator jobs: tenant purge, restore drill                             |
| `infra`              | AWS CDK: network, data, lake, security (CloudTrail, GuardDuty), app    |
| `docs/adr`           | Architecture decisions                                                 |
| `docs/security`      | Threat model and security policies                                     |
| `docs/runbook.md`    | Deploying, onboarding a pilot, purges, restore drills, incidents       |

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

### Live presence

```bash
pnpm dev:gateway
```

Set `MM_GATEWAY_SECRET` (shared by API and gateway) and `MM_GATEWAY_URL=ws://localhost:4200` in
`.env.local`. With the bridge installed, each Claude Code session shows up live to teammates, and
agents are told who else is working when that changes. See
[ADR 0006](docs/adr/0006-presence-and-skill-drafts.md).

### Overlap alerts

When two people's agents change the same lines (or the same file, or announce similar work), both
are alerted within seconds: in Claude Code through the bridge's hooks, elsewhere through
`check_overlaps`. Agents say what they're starting with `announce_intent`. See
[ADR 0007](docs/adr/0007-overlaps-and-skill-gate.md).

### Channels

When two agents need to coordinate (often after an overlap alert), one calls `channel_request`.
Both people approve in **Channels** in the web app (agents never can). Once it's open, the agents
message each other, claim resources, and agree who does what. Admins can close any channel or
turn channels off. See [ADR 0008](docs/adr/0008-channels-and-review.md).

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

### GitHub App

Register a GitHub App (Settings → Developer settings → GitHub Apps) with:

- **Permissions (all read-only):** Pull requests, Contents, Checks, Issues, Metadata.
- **Events:** Pull request, Pull request review, Check suite, Installation repositories.
- **Webhook URL:** `<api url>/webhooks/github`, with a random webhook secret.
- **Callback URL and Setup URL:** `<web url>/integrations/github/callback`, and tick
  **Request user authorization (OAuth) during installation**. The app uses it to confirm
  that the person installing can really access the installation.

Put the slug, client id and client secret in the web app's env, the webhook secret in the API's,
and the App id and private key in the worker's (`.env.example` lists the names; in AWS they are
the `mastermind/<stage>/github-*` secrets). Then an admin uses Settings → Integrations → Connect
GitHub. The worker imports 12 months of pull requests, then keeps them current from webhooks.
Members can link their GitHub account on the same page so their PRs are credited to them.

### Categories

Every task gets a category from its domain pack (`packages/packs`): the pack's rules first
(e.g. a `fix:` title or a `bug` label), then the agent's own hint, then Claude Haiku on the
redacted text. Set `MM_LLM_CATEGORIZE=off` locally to skip the model.

### Outcomes, judging and the backtest

The worker computes each merged PR's outcome once it is 60 days old: whether CI passed first
time, whether it was reverted, whether a later bug fix traces back to it (SZZ), and review rounds.
It then judges it against the pack's rules and the team's own baseline. See
[ADR 0005](docs/adr/0005-outcomes-and-judge.md).

```bash
pnpm --filter @mm/backtest backtest <tenant-id> --train-end 2026-07-01
```

```bash
pnpm --filter @mm/backtest label-agreement <tenant-id> labels.csv
```

The second compares hand labels (`repo,number,reverted,escaped_defect,ci_first_pass,verdict`)
with the system's; the bar is 85%.

### Skill drafts

```bash
pnpm --filter @mm/skills draft <tenant-id> --train-end 2026-07-01
```

Builds cohorts of successful and comparable unsuccessful work per category from the lake's
training window, and asks Claude Sonnet (Bedrock) for one skill per cohort. Every step cites the
PRs it came from.

Each draft then passes a gate before anyone reviews it: re-scan for secrets, personal data and
injected instructions; a second model checks each step against the PRs it cites; a rubric score;
and duplicates merge into the existing skill as a new version. Prompt changes are gated in CI:
`pnpm --filter @mm/skills eval` runs the 30 golden cases against Claude, and `eval:lock` records a
deliberate prompt change (with a version bump).

### Reviewing skills

Skills that pass the gate wait in **Skills → Review queue** until an admin or the category's owner
approves them; only approved versions reach agents. Reviewers can retire, restore and roll back
to any earlier version; every action is in the audit log.

### Skills for agents

Agents call `search_skills` and `get_skill` (approved versions only) and list the skills they
followed in `log_task`'s `skills_used`. On **Skills**, follow categories: the bridge then
installs their approved skills as Claude Code skills in `~/.claude/skills/mm-*` at each session
start (or run `mm skills sync`), and removes retired ones. Each skill's page shows whether work
that followed it did better than work that didn't; a skill that measurably hurts is flagged
back to its reviewers. See [ADR 0009](docs/adr/0009-delivery-hubspot-slack.md).

### Slack

Create a Slack app with bot scopes `chat:write`, `users:read` and `users:read.email`, the
redirect URL `<web>/integrations/slack/callback`, and interactivity pointing at
`<api>/webhooks/slack/interactions`. Set `MM_SLACK_CLIENT_ID`, `MM_SLACK_CLIENT_SECRET` and
`MM_SLACK_REDIRECT_URI` (web) and `MM_SLACK_SIGNING_SECRET` (API), then connect it from
**Settings → Integrations**. Channel requests arrive as DMs with Approve and Decline buttons.

### HubSpot

Create a HubSpot app with scopes `oauth`, `automation.sequences.read`, `crm.objects.owners.read`,
`crm.objects.contacts.read`, `marketing.email.read` and `crm.objects.deals.read`, and redirect URL
`<web>/integrations/hubspot/callback`. Set `MM_HUBSPOT_CLIENT_ID`, `MM_HUBSPOT_CLIENT_SECRET` and
`MM_HUBSPOT_REDIRECT_URI` (web and worker), then connect it from **Settings → Integrations**
(portals connected before week 10 reconnect once for the two new scopes). Every 30 minutes the
worker imports sequences, published marketing emails and deals. Results are recorded once they're
final: reply and meeting rates when a sequence is 30 days old, click and unsubscribe rates a week
after an email is sent, won or lost when a deal closes. Counts and stages only: no contact data,
message contents or deal amounts. See [ADR 0010](docs/adr/0010-packs-revenue-offboarding-hardening.md).

### Metrics for other teams (the generic pack)

Work that GitHub and HubSpot don't cover is judged by the generic pack, which admins edit under
**Settings → Metrics**: categories, metrics, and what counts as success or failure. Every change
is a new version; earlier work keeps the rules it was judged by. Results come from agents
(`report_outcome`) or a CSV upload on the same page (`ref,metric,value`, plus optional `n`,
`observed_at`, `title`, `owner_email`, `completed_at`, `category`; refs look like
`jira:issue:FIN-12`).

### Removing a member

Settings → Members → Remove (admins). It removes them from the WorkOS organization, deletes their
Postgres data at once, and the worker deletes their raw payloads and lake rows (twice, 15 minutes
apart, to catch rows still in flight). Old Iceberg snapshots expire within 11 days.

### Deleting an organization

An admin schedules it under **Settings → Organization**. The workspace is suspended at once
(agent keys, webhooks and jobs stop), any admin can cancel for 7 days, and then an operator runs
the purge, which removes everything, including the lake, whose key is destroyed. See
[the runbook](docs/runbook.md#tenant-purge).

### Pilot dashboard and backtest

Admins see a setup checklist on the dashboard until the pilot is set up; everyone sees team-level
numbers (work captured, outcomes, skills, overlaps), never per person. The backtest report for the
pilot:

```bash
DATABASE_URL=... pnpm --filter @mm/backtest backtest <tenant-id> --train-end 2026-07-01 --skills --overlaps --out backtest.md
```

## Security

[Threat model](docs/security/threat-model.md), [policies](docs/security/policies.md) and the
[runbook](docs/runbook.md). CI runs secret scanning (gitleaks), CodeQL, a dependency audit and
image scans (`.github/workflows/security.yml`). Draft DPA and member privacy notice for the pilot:
`docs/legal/` (for legal review).

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
