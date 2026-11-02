# ADR 0010: Admin-edited packs, the full revenue pack, tenant deletion, hardening

**Status:** accepted, week 10.

## Several rule sets per pack

The revenue pack judges three different kinds of work: sequences by reply rate, marketing emails
by clicks, deals by whether they were won. One rule set can't express that, because `requires`
would never be met for two of the three. So:

- **A pack may have `judges`:** a list of rule sets, each naming the categories it judges.
- **One catch-all at most:** a single rule set may leave out `categories`; it judges every
  category the others don't name.
- **Rules:**
  - all rule sets share one version, so judgments still key on (task, pack, version);
  - categories may not appear in two rule sets.
- **`judge` still works.** A single `judge` is unchanged and still valid. The engineering pack's
  rules and input hashes are identical, so its earlier judgments still replay.
- **Skipped categories are no longer selected.** The sweep now filters them out in SQL instead
  of loading and skipping them each time.

## The revenue pack, version 2

**Marketing emails** (scope `marketing.email.read`):

- **Import.** Published emails come with HubSpot's aggregate statistics (`includeStats`), one task
  each, credited to the publisher by HubSpot user id.
- **Final metrics.** Written once the email is a week old and reached at least 50 people:
  - `email.click_rate`;
  - `email.unsubscribe_rate`;
  - `email.open_rate`, shown but not judged, because mail privacy features inflate opens.
- **Judging.** Success needs a click rate at or above the team's 75th percentile with
  unsubscribes no worse than the 75th. Failure is a click rate below the 25th.
- **Not verified live.** Only `sent`, `delivered` and `open` are confirmed counter names in
  HubSpot's docs; `click` and `unsubscribed` must be checked against a live portal.

**Deals** (scope `crm.objects.deals.read`):

- **Import.** Name, stage, pipeline, type, created and closed dates, the two closed flags, and the
  owner. Never the amount, company or contacts.
- **When metrics are written.** Once a deal closes: `deal.won` and `deal.days_to_close`. Open
  deals have no completion date, so they aren't judged.
- **Categories.** The deal type becomes a label (`deal_type_newbusiness`), so pack rules can
  separate new business from expansion.
- **Judging.** Won is success, lost is failure.

**Reconnecting.** Existing HubSpot connections must reconnect once to grant the two new scopes.
Until they do, the sync fails with HubSpot's 403 and the integration page shows the error.

## Admin-edited generic pack

Admins edit the generic pack under **Settings → Metrics**: categories (name, description, title
keywords), metrics (id, unit, better direction, days until final) and success and failure rules
(against a number or the team's own percentiles). Power users can edit the YAML.

- **Every save is a new version (`tenant_packs`).** The stored version is also the ruleset
  version, so earlier judgments keep the rules they were made with and replay identically.
- **Concurrent saves are refused.** Each save names the version it started from.
- **Limits on what a tenant pack may claim.** It can't claim GitHub or HubSpot work, sources or
  code sessions, and only the generic pack is editable in the MVP.
- **Per-tenant loading.** The worker loads packs per tenant (`tenantPackLoader`, cached 30
  seconds): the built-ins, with the tenant's version in place of its pack.

## Outcomes from CSV

**Columns:**

- **Required:** `ref`, `metric`, `value`.
- **Optional:** `n`, `observed_at`, `title`, `owner_email`, `completed_at`, `category`.

**Finding the work:**

- `ref` uses the same `system:kind:id` form as every external ref, or a task id.
- A ref that matches no work creates it, if the row has a title and a member's work email.
  Opted-out members' rows are skipped.
- When an agent's task and a connector's task share a ref, the outcome goes to the connector's
  task, the result.

**Checks:**

- Only metrics defined in the tenant's packs are accepted, and values must fit the unit.
- Problems are reported per line without echoing cell values.
- Observation ids derive from (task, metric, time), so uploading the same file twice stores
  nothing new.

**Where it runs.** The import runs in the web app with the same redactor as ingest, minus AWS
Comprehend. Titles are short, and the deterministic rules plus the member directory catch the
personal data that matters here.

## Tenant deletion

**Two steps, so a mistake can be undone and nothing irreversible runs inside the app:**

1. **An admin schedules deletion (Settings → Organization).**
   - `mm_schedule_tenant_deletion` checks the admin role inside Postgres, records the request in
     `tenant_deletions`, and sets `tenants.suspended_at`.
   - Suspended tenants are refused by agent authentication, connection resolution (webhooks) and
     the job list. Their web pages redirect to the deletion page.
   - Any admin can cancel for 7 days.
2. **An operator runs the purge (`@mm/ops purge-tenant`, as the ops ECS task).** It runs these
   steps in order:
   - revoke HubSpot and Slack tokens;
   - delete the WorkOS organization;
   - delete raw payloads;
   - drop the lake: tables, namespace, workgroup, role and query results, then schedule the
     tenant's KMS key for deletion;
   - `mm_purge_tenant` deletes every Postgres row of the tenant;
   - verify, then mark the deletion purged.

**The purge can be resumed.** Each step is recorded in `tenant_deletions.steps`, so a run that
stops partway can be repeated.

**Purging the audit log.** The audit trigger now allows one exception: a DELETE by the owner
role while `mm.purge_tenant` names that tenant, inside `mm_purge_tenant`. The app role has no
DELETE grant on the audit log, so it can't use the exception.

**What remains afterwards.** The deletion record (ids and dates), and database backups until
they expire (30 days).

**Tests:**

- The isolation suite seeds every table, then checks that a purge leaves zero rows of the tenant
  in every table, including tables added later, and the other tenant unchanged.
- An end-to-end test does the same across Postgres, raw storage, the lake and the token
  revocation calls.

## Hardening

- **SecurityStack:**
  - **CloudTrail:** all regions, file validation, KMS, data events on raw payloads.
  - **GuardDuty:** S3, RDS logins and Fargate runtime.
  - **Security Hub:** AWS foundational best practices and CIS 3.0, with Config recording.
  - **Alerts:** high findings go to an encrypted SNS topic.
  - **Evidence bucket:** object-locked; compliance mode in production.
- **Ops task.** A task definition, never a service, runs the purge and restore drill inside the
  VPC. Its role can schedule deletion only of KMS keys tagged `mm:purpose=lake-tenant`, and can
  delete only `mm-restore-drill-*` database instances.
- **CI security workflow:**
  - gitleaks over the full history, with an allowlist for deliberate test fixtures;
  - CodeQL `security-extended`;
  - `pnpm audit` on production dependencies;
  - Trivy scans of both images.
  - Dependabot now covers the Dockerfiles too.
- **Web headers.** A Content-Security-Policy that blocks framing, plugins, base-tag tricks and
  third-party loading. Inline scripts are still allowed until nonces are added.
- **Documents:**
  - `docs/security/threat-model.md`, including agent-to-agent injection;
  - `docs/security/policies.md`;
  - `docs/runbook.md`;
  - DPA and privacy notice drafts in `docs/legal/`, for counsel.

## Pilot backtest report

The backtest adds the plan's §11 checks to the v0 outcome tables:

- **Skill lift.** Skills come from drafts whose window ended before the split. A Haiku labeller
  that never sees outcomes says whether each test-window task followed the skill. The lift gets
  an Agresti-Caffo interval.
- **Placebo.** The labels are shuffled 200 times with a fixed seed; the lift must vanish.
- **Overlap replay.** Pull request history is replayed through the file-level overlap rule. It
  reports alert precision and conflicts and defects in flagged vs. unflagged work. Line-level
  replay needs changed line ranges, which past PRs don't have.
- **Pitch bar.** The summary checks the bar: at least 3 credible skills, a clean placebo, and
  overlap precision of at least 60%.

## Pilot dashboard

The dashboard shows:

- an admin setup checklist, read from the data;
- work captured per week and by source;
- outcomes per pack;
- skills served, used, improving or flagged;
- overlaps and channels.

Success rates appear only when at least 5 people contributed, and nothing is shown per person.
