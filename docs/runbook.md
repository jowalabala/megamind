# Runbook

How to run Master Mind in AWS: deploying, onboarding a pilot, the operator tasks (tenant purge,
restore drill), and what to do when something goes wrong. Security policies are in
[security/policies.md](security/policies.md).

Stack outputs below come from `MasterMind-<stage>-*` stacks (`aws cloudformation describe-stacks`).

## Deploy

```bash
pnpm --filter @mm/infra cdk deploy -c stage=prod -c alertEmail=security@<domain> --all
```

- After the first deploy, fill in the empty secrets (`mastermind/<stage>/workos`,
  `-github-*`, `-hubspot`, `-slack`) and force a new deployment of the services.
- Migrations: run `pnpm --filter @mm/db migrate` with the owner URL from the RDS master secret,
  from inside the VPC (the ops task, or a bastion session).
- Confirm the email subscription for security alerts (AWS sends a confirmation link).
- `securityServices: "existing"` stages assume GuardDuty, Security Hub and Config are already on
  in the account (another stage created them).

## Onboarding a pilot (target: under 30 minutes)

| #   | Who            | Step                                                                                                                                    | Time       |
| --- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | Customer admin | Signs in at the web app and creates the organization                                                                                    | 2 min      |
| 2   | Us             | Provision the tenant's lake: `pnpm --filter @mm/lake provision-tenant <tenant-id>` (README, "Lake in AWS"); marks the tenant lake-ready | 5 min      |
| 3   | Customer admin | Settings → Integrations → Connect GitHub (choose repositories); history import starts                                                   | 5 min      |
| 4   | Customer admin | Settings → Members → invite the team; each member reads Settings → Privacy                                                              | 5 min      |
| 5   | Each developer | Settings → Agents → create a key, then `mm login` and `mm install` (the bridge; README)                                                 | 3 min each |
| 6   | Customer admin | Skills → Review queue → name a reviewer per category                                                                                    | 2 min      |
| 7   | Optional       | Connect Slack (approvals, alerts) and HubSpot; add metrics for other teams (Settings → Metrics)                                         | 5 min      |

The dashboard shows the same checklist to admins and ticks steps off from the data. Before the
customer starts: the DPA is signed, and the privacy notice has gone to every member.

## Backtest report for the pilot

Once the GitHub (and HubSpot) history is imported and judged (the worker does this on its own):

```bash
pnpm --filter @mm/skills draft <tenant-id> --train-end <split date>
DATABASE_URL=... pnpm --filter @mm/backtest backtest <tenant-id> --train-end <split date> --skills --overlaps --out backtest.md
```

The default split is three months before today. `--skills` makes one Haiku call per test-window
task per skill (capped at 200 per skill with `--max-tasks`). Spot-check 50 labels by hand before
sharing; the report states what wasn't run.

## Tenant purge

Admins schedule deletion under Settings → Organization. The tenant is suspended at once, and
the grace period is 7 days. Purge after it ends:

```bash
aws ecs run-task --cluster <ClusterName> --task-definition <OpsTaskDefinition> \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<private subnet>],securityGroups=[<OpsSecurityGroup>]}" \
  --overrides '{"containerOverrides":[{"name":"ops","command":["node","ops/purge-tenant.js","<tenant-id>"]}]}'
```

Only with the admin's written request to skip the grace period, add `"--now","--yes"`.

What it does, in order, recording each finished step:

1. Revokes the HubSpot refresh token and the Slack bot token.
2. Deletes the WorkOS organization.
3. Deletes raw payloads (`raw/tenant=<id>/`).
4. Drops the lake: tables, namespace, Athena workgroup, query role and query results, and
   schedules the tenant's KMS key for deletion (7 days). After that, nothing left anywhere can
   be decrypted.
5. Deletes every Postgres row of the tenant, audit log included.
6. Verifies that no rows or raw payloads remain, then marks the deletion purged.

If it stops partway, run it again: finished steps are skipped. Afterwards, tell the customer's
admin it's done, and remind them to uninstall the GitHub App. The `tenant_deletions` row
(ids and dates only) is the record that the deletion happened. Locally, the same command works
with `DATABASE_ADMIN_URL`, `.data/bronze` and `.data/lake`:

```bash
DATABASE_ADMIN_URL=... pnpm --filter @mm/ops purge-tenant <tenant-id>
```

## Restore drill (quarterly)

```bash
aws ecs run-task ... --overrides '{"containerOverrides":[{"name":"ops","command":["node","ops/restore-drill.js"]}]}'
```

It restores production to `mm-restore-drill-<date>`, checks migrations, row counts and every
tenant's audit chain, deletes the instance, and writes `restore-drills/<date>.md` to the evidence
bucket. A failed check exits non-zero. Note the time to restore against the 4-hour target.

## Incidents

| Signal                                            | First steps                                                                                                             |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| GuardDuty / Security Hub alert email              | Open the finding; if it involves a task role, scale that service to 0 and rotate its secrets                            |
| A customer reports seeing another customer's data | Severity 1. Scale the web and API services to 0, keep logs, find the query path, run the isolation suite against a copy |
| Leaked agent key                                  | The member or an admin revokes it (Settings → Agents); check `agent_identities.last_used_at` and the audit log          |
| Leaked HubSpot or Slack token                     | Disconnect in the provider, reconnect from Settings → Integrations (re-seals a new token)                               |
| A skill misbehaving                               | Retire it (Skills → skill → Retire): agents stop receiving it at once; the bridge removes the file at the next session  |
| An agent channel misbehaving                      | Close it from Channels; the tenant kill switch stops all channels                                                       |
| Worker stuck                                      | CloudWatch logs (`worker` prefix); jobs are idempotent, so restarting the service is safe                               |

Severity, notification deadlines and the review are in the policies (section 5).

## Rotating secrets

- **Pseudonym secret:** don't. Rotating it changes every pseudonym, so earlier and later data no
  longer link. Only after a suspected leak, and with a note in the audit trail.
- **Gateway secret:** rotate in Secrets Manager, then redeploy the API and gateway together
  (5-minute tokens; agents reconnect).
- **GitHub webhook secret / App key, HubSpot and Slack app secrets:** rotate in the provider,
  update the secret, redeploy the services that use it.
- **Database passwords:** RDS master via Secrets Manager rotation; `mm_app` by updating the
  secret and `ALTER ROLE` together, then redeploying.
