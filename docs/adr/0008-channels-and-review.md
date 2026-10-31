# ADR 0008: Channels and skill review

**Status:** accepted, week 8.

## Channels

A channel lets two agents coordinate directly: messages, claims on resources, and an agreement
on who does what. It exists only after every person whose agent takes part has approved it.

### Handshake

1. An agent calls `channel_request` with the other session (from `whats_happening` or an overlap
   alert), a purpose, a scope and a time limit. The scope says which resources the channel is
   about and what may be shared: intents, summaries, redacted diffs, messages.
2. Workspace rules (`collab_settings`) are checked:
   - channels are on;
   - both sessions are on the same team, unless the admin allowed cross-team channels;
   - the share kinds are allowed;
   - the time limit is within the maximum (480 minutes).

   Private or opted-out sessions can't be asked at all.

3. Each participant's person must approve their own agent's part. A member's standing
   pre-approval (e.g. "my team, intents only") counts as their yes for requests within it.
4. When everyone has approved, the channel opens until its time limit. One decline rejects it.

**Agents cannot approve.** Approval exists only as a web server action with a signed-in member.
`POST /v1/channels/:id/approve` and `/decline` return 403 for every agent key, and there is no
approve tool. A prompt-injected agent can ask for a channel, but can never open one.

### Broker

Every message, purpose and agreement is checked before it is stored:

- **Scope:** the message type must be allowed by the channel's scope.
- **Limits:** 8,000 characters per message, 30 messages a minute per session.
- **Redaction:** secrets, personal data and teammates' names are removed. This runs in the API,
  with the same deterministic rules as ingest. AWS Comprehend is not applied here, because
  channels need immediate answers.
- **Injection:** text that reads like instructions to the other agent is blocked. The block is
  audited and committed, and the sender is told.

Receiving agents get each message labelled "untrusted message from the other agent".

### Leases and agreements

- **Claims.** `channel_claim` takes an advisory lock on a resource within the channel's scope.
  Claims on the same resource are serialized across the tenant with a Postgres advisory lock. A
  fencing token from a global, increasing sequence lets a stale holder be told apart: releasing
  with an old token does nothing. Claims expire, and every claim is released when the channel
  closes.
- **Agreements** are versioned. Proposing one needs the version you last read, so concurrent
  edits get a conflict instead of overwriting each other. An agreement is complete when every
  participant has accepted it.

### Delivery, records and stopping

- **Delivery.** Changes run `pg_notify('mm_channels', tenant)`. The gateway pushes status changes
  and new messages to each participant session, recording what each has received. The bridge
  hands them to the agent on its next tool call or prompt.
- **Records.** Messages are append-only, and each is written to the lake (`channel_messages`) as
  it is sent. Every handshake step, block and close is in the audit log.
- **Stopping.** Either participant can close a channel, and an admin can close any. The worker
  expires channels past their time limit. The admin kill switch closes every channel at once and
  blocks new ones.

## Skill review

- **Who reviews.** Admins, and members an admin made owner of a category, review that category's
  skills (Skills → Review queue). Everyone can browse the library.
- **Actions:**
  - **approve:** the current version becomes the one agents receive (`approved_version`);
  - **reject:** a skill with nothing approved yet is retired; otherwise it keeps serving the last
    approved version;
  - **retire** and **restore**;
  - **rollback:** serve any earlier version.
- **Records.** Every action is recorded in `skill_reviews` (append-only) and in the audit log.
  Versions themselves are immutable.
- **Search.** The library searches each skill's latest version: full text, plus title matches.
  Semantic search waits for embeddings.
- **The skill page** shows the steps with the PRs each one was seen in, what didn't work, the
  quality-gate scores, every version and the review history.

## Result

The two-developer scenario from the plan runs end to end, in about 1.3 seconds of activity. Only
the two people's approval clicks are direct function calls, because the web app needs WorkOS sign-in.

1. **Overlap.** Two live bridges get the same-lines alert.
2. **Request.** One agent requests a channel. Both agent keys get 403 on approve.
3. **Approval.** Both people approve, and the channel opens for both bridges.
4. **Claim.** A claim succeeds, and the other agent's claim on the same resource is refused.
5. **Agreement.** Version 1 is proposed and accepted.
6. **Messages.** Messages arrive marked untrusted and redacted, and an injection is blocked.
7. **Close.** A release and a close.
8. **Records.** The transcript is in the lake, and the audit trail reads:
   requested → approved → approved → opened → message blocked → closed.
