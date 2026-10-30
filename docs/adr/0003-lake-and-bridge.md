# ADR 0003: The lake, history search and the local bridge

**Status:** accepted, week 3. The AWS parts are built and unit-tested but not yet deployed.

## Decision

### Getting rows into the lake

- **Transactional outbox.** The worker writes each task, outcome and action to Postgres, and
  writes its lake copy into `lake_outbox`, in the same transaction. A row reaches the lake if and
  only if its Postgres twin was committed. Lake rows hold only redacted values.
- **Publisher.** Every 5 seconds the worker claims outbox rows tenant by tenant
  (`FOR UPDATE SKIP LOCKED`, inside that tenant's RLS context), sends them, and deletes the ones
  that were accepted. Delivery is at-least-once. Readers de-duplicate on `event_id`.
- **Firehose → Iceberg.** In AWS the sink is one Firehose stream writing Iceberg tables in an
  S3 table bucket. Each record carries its tenant namespace and table; a JQ metadata-extraction
  step routes on them. The 60-second buffer plus the 5-second publisher keeps the lake within
  about 2 minutes of Postgres.
- **Locally**, the same interfaces write newline-delimited JSON files (`.data/lake/`), so the whole
  flow runs and is tested without AWS.

### One tenant, one namespace, one key, one role

Each tenant gets the following, created by `pnpm --filter @mm/lake provision-tenant`:

- an S3 Tables namespace `t_<tenant hex>`;
- its own KMS key, with every table encrypted under it;
- an Athena workgroup whose results go under the tenant's prefix, encrypted with that key;
- an IAM query role that can only read and delete that namespace (Lake Formation grants) and use
  that key.

The worker queries or erases lake data only by assuming that tenant's role, so a bug in a query
can't cross tenants.

Provisioning is an operator CLI rather than a service, so the running services never hold
IAM or KMS admin rights. Tenant roles must live under `/mastermind/<stage>/lake/` and carry a
permissions boundary from the lake stack, which caps what any of them can ever be granted.

### History search

`search_history` (MCP and `POST /v1/history/search`) reads Postgres: all tasks plus 90 days of
actions, via full-text search on the redacted text and substring search on resources and refs.

Visibility is applied in SQL:

- other members' private sessions are hidden, and so is everything from members who opted out;
- an author is shown by name only to people who share a team with them, and only if their
  preference allows it; otherwise as their team, or as "a teammate".

Results go back to the agent marked as information, not instructions, because they are text
written by other agents.

### Erasing a member

1. An admin removes the member. Their WorkOS membership is deleted first, so they can't sign back
   in and be recreated.
2. The member row is deleted, which cascades to everything they captured, including unpublished
   outbox rows.
3. The worker deletes their raw payloads, since bronze keys are now
   `raw/tenant=<t>/member=<m>/...`.
4. The worker deletes their lake rows twice, 15 minutes apart, so the second pass catches rows
   that were still in Firehose's buffer.
5. Old Iceberg snapshots still hold the rows until they expire (7 days), and unreferenced files are
   then removed (3 + 1 days). Each request records the date by which the data is physically gone.

### The bridge (`mm`)

The bridge is a local CLI with three parts:

- **A stdio MCP server** with the same tools as the remote server.
- **Claude Code hooks:**
  - `SessionStart` tells the agent about `search_history` and `log_task`;
  - `PostToolUse` turns each tool call into a one-line action event;
  - `Stop` and `SessionEnd` send whatever is waiting.
- **A local spool:** hooks append to a file and send in batches, so each hook costs milliseconds,
  and nothing is lost while offline.

What leaves the machine is limited:

- **Metadata only.** Action events hold the tool, the file path relative to the repository with its
  changed line ranges (`git:<repo>:<path>#L10-42`), and the command line. They never hold file
  contents or tool output. Files outside the project are never named.
- **Clean repository ids.** The repo id comes from the origin remote with any user names and
  tokens stripped.
- **Secrets stripped twice.** Secrets are removed on the machine before sending, and the server
  redacts again. Redaction is idempotent: placeholders from the first pass are left alone. A
  corpus-wide test checks this.

The agent key is kept in the macOS Keychain or Linux Secret Service. It is passed on stdin, never
as a command-line argument. A file readable only by the user is the fallback.

## Why

- **The outbox rather than writing to Firehose directly from the transaction:** there is no
  dual-write gap, and no lake copy of a row that was rolled back.
- **Postgres, not the lake, for live search:** answers in milliseconds, with the same RLS and
  visibility rules as everything else. The lake is for cohorts, backtests and long-range history.
- **Hooks and a spool, not asking the agent to report each step:** capture doesn't depend on the
  agent remembering to do it.

## Not yet verified in AWS

These follow AWS documentation and SDK types and are unit-tested against recorded fake clients.
Check them on the first deploy:

- **Firehose routing.** Firehose's JQ routing into per-tenant S3 Tables namespaces. The record
  format is ISO timestamps and JSON-string list columns.
- **Lake Formation for S3 Tables.** The grants: the catalog id format
  `<account>:s3tablescatalog/<bucket>`, `ALL` for Firehose, and `DELETE` for tenant roles.
- **Athena `DELETE`.** That it works on S3 Tables.
- **Physical erasure.** Whether S3 Tables compaction rewrites data files that carry position
  deletes. If it doesn't, the erased rows stay inside a still-referenced data file. In that case,
  add a periodic rewrite of affected partitions to the erasure job.
- **The KMS key policy.** The encryption-context condition for S3 Tables maintenance.
