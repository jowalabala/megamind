# Threat model

**Status:** week 10, before the pilot. Review it whenever a new data source, integration or
agent capability is added, and at least every six months.

## What we protect

| Asset                                                              | Where it lives                                                             | Why it matters                                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Captured work (titles, summaries, agent actions, channel messages) | Postgres (90 days hot), the lake (12 months), raw payloads in S3 (30 days) | Can reveal plans, code structure, customers and people                         |
| Outcomes and judgments                                             | Postgres, the lake                                                         | Misused, they become performance surveillance                                  |
| Skills                                                             | Postgres                                                                   | Agents act on them: a poisoned skill is an attack on every agent that reads it |
| OAuth tokens (HubSpot, Slack) and the GitHub App key               | Postgres (sealed with KMS), Secrets Manager                                | Reach into customer systems                                                    |
| Agent API keys                                                     | Postgres (hash only), the user's keychain                                  | Act as a member                                                                |
| The audit log                                                      | Postgres (hash-chained, append-only)                                       | Proof of who did what                                                          |

## Who might attack

1. **Another tenant** trying to read or change this tenant's data.
2. **A compromised or prompt-injected agent** inside the tenant: it holds a valid key.
3. **A malicious insider** at the customer: a member trying to see others' work or results.
4. **Untrusted content** that flows through us: PR descriptions, emails, deal names, CSV cells,
   agent messages. Anyone who can write a PR title can try to inject instructions.
5. **An external attacker** on the internet: webhooks, OAuth callbacks, the web app.
6. **A Master Mind operator** misusing access, or an operator account being compromised.

## Threats and mitigations (STRIDE)

### Spoofing

| Threat                                | Mitigation                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Forged GitHub or Slack webhook        | HMAC signatures verified on the raw body; Slack requests older than 5 minutes refused (replay)                                          |
| Stolen agent key                      | Keys are scoped, hashed, revocable, bound to one member; the bridge keeps them in the OS keychain; suspended tenants' keys stop working |
| OAuth callback CSRF or code injection | Signed, short-lived `state`; GitHub installs confirmed through the user's own OAuth token                                               |
| An agent approving its own channel    | Approval endpoints refuse agent keys; Slack approvals map the Slack user to the member, never to an agent                               |

### Tampering

| Threat                                                | Mitigation                                                                                                                                                                                    |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editing the audit log                                 | Append-only: no UPDATE/DELETE grant for the app, a trigger blocks it for everyone; hash chain verified in restore drills. The only exception is a whole-tenant purge by the owner role        |
| Rewriting history to change judgments                 | Judgments carry an input hash and ruleset version; replays must match. Pack edits create new versions; old judgments keep theirs                                                              |
| Poisoned skill                                        | Skills cite evidence; a second model verifies each step; rubric; output re-scanned for injection and secrets; human approval required; a degradation flag sends harmful skills back to review |
| CSV upload changing other tenants' or teams' outcomes | Imports run in the admin's tenant context (RLS); only metrics defined in the tenant's packs are accepted; values checked against the unit                                                     |

### Repudiation

Every state change that matters (approvals, connections, opt-outs, pack edits, imports, deletion
requests) writes an audit event in the same transaction. Bronze reads and deletes are logged by
CloudTrail data events. Operators run purges and drills as ECS tasks, logged in CloudTrail and
CloudWatch.

### Information disclosure

| Threat                                    | Mitigation                                                                                                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-tenant reads                        | Postgres RLS forced on every table, `mm_app` can't bypass it; a CI suite checks every table, including ones added later. The lake: one namespace, KMS key, IAM role and Athena workgroup per tenant |
| Secrets or personal data in captured text | Redacted in the bridge (secrets) and again on the server before any storage, model call or lake write; recall ≥ 0.95 on a labelled corpus                                                           |
| Surveillance of individuals               | No per-person failure views; success rates shown only when at least 5 people contributed; opt-out drops data at ingest; private sessions                                                            |
| Connector over-collection                 | Read-only scopes; HubSpot: counts and stages only, never contacts or amounts                                                                                                                        |
| Leaking through model calls               | Bedrock in-region; captured content wrapped as untrusted; extraction calls get no tools                                                                                                             |
| Data kept after a customer leaves         | Tenant deletion purges Postgres, raw payloads, the lake, query results and connector tokens, and destroys the tenant's lake key (see the runbook)                                                   |

### Denial of service

Body size limits on every endpoint; per-key rate limits on the API and channel broker; Athena
workgroups capped per query; CSV uploads capped at 2 MB and 5,000 rows; GitHub and HubSpot rate
limits respected with backoff.

### Elevation of privilege

| Threat                                 | Mitigation                                                                                                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A member acting as admin               | Admin-only actions check the role server-side; tenant deletion is checked again inside Postgres                                                                                                                 |
| A service task gaining operator rights | Services hold least-privilege roles; lake provisioning and purge rights live only in the ops task definition (never a running service) and operator SSO; tenant lake roles are capped by a permissions boundary |
| Escaping the tenant context in SQL     | All access through `withTenant`; SECURITY DEFINER functions set the tenant themselves and return ids only                                                                                                       |

## Agent-to-agent prompt injection

This is the threat specific to Master Mind: content written by one party is read by another
party's agent.

**Paths:**

1. **Channel messages:** agent B sends text that tries to make agent A act.
2. **Skills:** text from a PR or an email ends up in a skill.
3. **History search:** a poisoned task summary is returned to an agent.
4. **Overlap alerts:** intents and resource names written by one agent are shown to another.

**Defenses, in layers:**

- **Nobody talks without consent.** A channel opens only after each human owner approves
  out-of-band (web or Slack), and agents can't approve. Scope limits what may be shared; diffs are
  off by default. TTL is 8 hours at most, and there is a kill switch per tenant and per channel.
- **Everything is scanned.** The broker redacts and scans every channel message for injection
  patterns before delivery; skills are re-scanned before review; summaries are redacted at ingest.
- **Everything is labelled as untrusted.** Delivered messages, alerts and search results are wrapped
  as untrusted content from a named agent. Our own model calls wrap captured text the same way.
- **Humans stay in the loop for anything lasting.** Skills need approval; agreements are visible to
  both humans; a degradation flag catches skills that hurt results.
- **Audit:** every handshake step, message (redacted), lease and agreement is recorded.

**Residual risk:** pattern scanning can't catch every injection, and the receiving agent's own
model decides what to do with untrusted text. We reduce the blast radius (scoped channels, short
TTLs, human approval) rather than claim detection is complete.

## Accepted risks and follow-ups

| Item                                               | Why accepted now                                           | Plan                                                           |
| -------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| The web app's CSP allows inline scripts            | Next.js inlines its bootstrap; nonces need middleware work | Nonce-based CSP after the pilot                                |
| HTTPS on the load balancer isn't configured yet    | No domain chosen                                           | Required before real data: ACM certificate and HTTPS listener  |
| Audit log isn't yet mirrored to object-locked S3   | The evidence bucket exists; the mirror job doesn't         | Mirror daily into the evidence bucket                          |
| Deal names may contain customer company names      | Useful for categorizing; not personal data                 | Offer a "names off" setting per tenant                         |
| Line-level overlaps can't be replayed from history | Past PRs' changed line ranges weren't kept                 | Keep hunk ranges for new PRs                                   |
| One AWS account for dev and prod                   | Two founders, pilot stage                                  | Separate accounts (AWS Organizations) before a second customer |
