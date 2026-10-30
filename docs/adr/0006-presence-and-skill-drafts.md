# ADR 0006: Live presence and skill drafts

**Status:** accepted, week 6.

## Presence

### Connecting

- **Tokens.** An agent asks the API for a gateway token (`POST /v1/gateway/token`, scope
  `collab`). The token is an HMAC over tenant, agent and member, and lasts 5 minutes. The agent
  key never reaches the WebSocket endpoint.
- **Subprotocols.** The client offers `mm.v1` and `mm.token.<token>` as WebSocket subprotocols,
  so the token never appears in a URL or an access log. Node's built-in WebSocket client can't
  send headers, and this works without them.
- **Messages.** The client says `hello` with its session (repository, branch and tool are
  redacted like any captured text), sends a heartbeat every 30 seconds, and says `bye` when the
  session ends.
- **Who counts as present.** A session is present if it sent a heartbeat in the last 60 seconds.
  A dropped connection fades out after that window rather than vanishing, so reconnects don't
  flicker.

### Fan-out across gateway instances

1. Any change runs `pg_notify('mm_presence', <tenant id>)` in the same transaction.
2. Every gateway instance listens. On a notification, it recomputes each of its viewers' lists
   and pushes the ones that changed.
3. A 15-second sweep catches sessions that stopped sending heartbeats.

The notification carries only a tenant id. What each viewer sees is computed by the same SQL as
history search.

### Visibility

- **Names:** shown only to people on the same team, and only if the person allows it;
  otherwise their team, or "a teammate".
- **Branches:** shown only within a team.
- **Private sessions:** invisible to everyone else.
- **Opted-out members:** can't connect at all (close code 4003). Opting out also means not
  appearing live.

### Safety limits

- **Message limits:** 16 KB per message and 20 messages per 10 seconds.
- **Revoked keys:** a revoked agent is disconnected on its first message, and checked again every
  5 minutes.
- **Reconnects:** the same session connecting again replaces the older socket.

### The bridge

Claude Code's MCP server doesn't know its session id, so presence is driven by the hooks:

1. `SessionStart` starts `mm presence <session> <cwd>` in the background.
2. That process keeps the socket open and writes the latest list to a local file.
3. `UserPromptSubmit` adds "teammates' agents active right now: …" to the agent's context, but
   only when that list changed.
4. The process says `bye` when `SessionEnd` asks it to, or after 20 minutes without tool use.

Agents can also call `whats_happening` (MCP, or `GET /v1/presence`).

## Skill drafts

### Cohorts

- **Lake only.** Cohorts are built from the lake, within a training window, so a backtest can
  never see the future.
- **Which categories qualify.** A category needs at least 5 successes and at least 20 decided
  verdicts (inconclusive ones don't count).
- **Pairing.** Up to 15 recent successes are paired with failures of similar size (lines
  changed). Neutral results fill any gap.
- **Hints.** Features whose means differ by 20% or more go to the model as leads, not conclusions.

### Extraction

- **Model.** Claude Sonnet (prompt `skills.extract`, version 1) with no tools. The task text goes
  in as untrusted data, under short reference ids (S1…, F1…) instead of task ids.
- **Output.** The output is schema-validated. It has a title, when to use it, preconditions,
  steps, anti-patterns and the expected outcome. The model may also say that no clear practice
  separates the groups.
- **Grounding.**
  - Each step must cite at least 2 successes from the cohort, and anti-patterns must cite failures.
  - Citations that don't exist, or that point at the wrong group, are removed and counted.
  - A draft left with fewer than 2 steps is rejected.

### Storage

Drafts go into `skill_drafts`, together with their cohort.

- **Ids:** deterministic per window and prompt version, so re-running a window adds nothing.
- **Low confidence:** drafts from cohorts with fewer than 8 successes are flagged as low confidence.

Review, versions and deployment come in weeks 7–9.

## Not yet done

- Clustering successes by embedding: each category is one cohort for now.
- The verifier, rubric and output re-scan (week 7).
- Cohorts read through Athena in AWS: same code, untested there.
- Running real Sonnet on real history. The prompt's quality is unmeasured until the eval harness
  in week 7.
