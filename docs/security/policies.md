# Security policies

**Status:** draft v1, week 10. Owner: the platform/security founder. Reviewed every six months
and after any incident. These are written to be followed by a two-person company and to grow
into SOC 2 controls; each section names where the evidence lives.

## 1. Access control

- **People.** Production AWS access is through AWS SSO with MFA, no IAM users or long-lived keys.
  Two roles: _operator_ (read, run ops tasks) and _admin_ (change infrastructure). Admin is used
  only for deploys and break-glass, and every use is visible in CloudTrail.
- **Services.** Each service has its own task role with only what it needs (checked by
  `infra/test/stacks.test.ts`). The app's database role can't bypass row-level security and owns
  no tables. Lake provisioning and tenant purges run only as operator tasks.
- **Customers.** Sign-in through WorkOS (Google, Microsoft, magic link). Roles: admin, category
  owner, member. Agent keys are per member, scoped, revocable and stored only as hashes.
- **Reviews.** Every quarter, list SSO users, WorkOS admins of our own org, GitHub org members and
  deploy keys; remove what isn't needed. Record the review in the evidence bucket.
- **Leavers.** Remove SSO, GitHub and WorkOS access the same day.

## 2. Change management

- All changes go through pull requests to `main`, with branch protection: CI green (lint, types,
  tests including the cross-tenant suite, builds, CDK synth) and the security workflow (secret
  scan, CodeQL, dependency audit, image scan).
- With two people, the author may merge their own PR only when CI is green and the change has no
  security impact; changes to auth, RLS, migrations, IAM or redaction need the other founder's
  review.
- Database migrations are append-only SQL; the Drizzle schema must match (tested).
- Prompt changes are gated by the eval suite and versioned.
- Infrastructure changes only through CDK (`cdk diff` attached to the PR for IAM or network
  changes).

## 3. Encryption

- In transit: TLS everywhere (RDS forces SSL, buckets refuse plain HTTP). HTTPS on the load
  balancer is required before real customer data (see the threat model).
- At rest: RDS, S3 and SNS encrypted with KMS; one KMS key per tenant for the lake (rotation on);
  OAuth tokens sealed with a dedicated key the API can't use. Keys are never exported.

## 4. Logging and monitoring

- CloudTrail in every region with log file validation, encrypted, kept 2 years in production.
  Reads and deletes of raw payloads are logged.
- GuardDuty (S3, RDS logins, Fargate runtime) and Security Hub (AWS foundational best practices,
  CIS) are on; findings of high severity are emailed to both founders.
- Application logs in CloudWatch for one year. Logs never contain captured content, tokens or
  keys.
- The audit log is hash-chained per tenant and checked in every restore drill.

## 5. Incident response

1. **Detect:** a GuardDuty or Security Hub alert, a customer report, or anything odd in logs.
2. **Triage (within 4 hours):** severity 1 = customer data exposed or at risk; 2 = a control
   failed with no known exposure; 3 = everything else. Open a private incident note.
3. **Contain:** revoke keys or tokens, scale a service to zero, use the per-tenant or per-channel
   kill switch, rotate secrets (runbook).
4. **Notify:** for severity 1, tell affected customers without undue delay and within 72 hours
   of confirming a personal data breach (DPA section 8), with what is known and what we're doing.
5. **Recover and learn:** fix, verify, and write a short blameless review within a week. Add a
   test or alert so it can't recur silently.

## 6. Data retention and deletion

| Data                      | Kept                     | Then                                       |
| ------------------------- | ------------------------ | ------------------------------------------ |
| Raw payloads (bronze)     | 30 days                  | Deleted by bucket lifecycle                |
| Agent actions in Postgres | 90 days                  | Pruned daily; kept in the lake             |
| Lake tables               | 12 months (configurable) | Row deletes, then snapshot expiry (7 days) |
| Audit log                 | Life of the tenant       | Purged with the tenant                     |
| Application logs          | 1 year                   | Expired by CloudWatch                      |
| CloudTrail                | 2 years (prod)           | Lifecycle                                  |

- **A member's data:** an admin removes them; Postgres rows go at once, raw payloads and lake rows
  within about 15 minutes, old lake snapshots within 11 days.
- **A whole tenant:** an admin schedules deletion; after 7 days (cancellable until then) an
  operator runs the purge: Postgres, raw payloads, lake tables, query results, connector tokens
  revoked, sign-in organization removed, lake key scheduled for destruction (7 days). The purge
  verifies nothing remains and keeps a dated record of each step.

## 7. Backup and restore

- RDS automated backups (30 days in production) with point-in-time recovery; deletion
  protection on. The lake is rebuilt-able from Postgres for the last 90 days and is itself
  durable (S3).
- **Restore drill every quarter** (`restore-drill` ops task): restores production to a new
  instance, checks migrations, row counts and every tenant's audit chain, records time to
  restore, deletes the instance, and stores the report in the object-locked evidence bucket.
- Targets: recovery point 5 minutes, recovery time 4 hours.

## 8. Vendors

| Vendor  | What they get                                         | Why                                                                           |
| ------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| AWS     | Everything (hosting, Bedrock models)                  | Infrastructure; Bedrock keeps prompts in the region and doesn't train on them |
| WorkOS  | Names, emails, org membership                         | Sign-in                                                                       |
| GitHub  | Nothing from us; we read with read-only scopes        | Customer's own connector                                                      |
| HubSpot | Nothing from us; we read counts with read-only scopes | Customer's own connector                                                      |
| Slack   | DMs we send (approval requests, skill updates)        | Notifications                                                                 |

Review each vendor's SOC 2 report or equivalent yearly; new vendors that receive customer data
need both founders' agreement and a DPA update.

## 9. Secure development

- Dependencies: Dependabot weekly; `pnpm audit` fails CI on high or critical advisories in
  production dependencies; container images scanned with Trivy.
- Secrets: never in code (gitleaks on the full history in CI); in Secrets Manager in AWS.
- Untrusted input: validated with zod at every boundary; captured text is redacted before
  storage and wrapped as untrusted before any model sees it.
- Tests: the cross-tenant isolation suite covers every table automatically; tenant deletion has
  an end-to-end test.
