# ADR 0007: Overlap alerts and the skill quality gate

**Status:** accepted, week 7.

## Overlap alerts

### What a session touches

A session's footprint is:

- the resources of its active intent (`announce_intent`: a description plus resource keys);
- the resources of its actions in the last two hours.

The bridge reports edits with their changed lines, as `git:<repo>:<path>#L<a>-<b>`. Keys are
normalized: repo lowercased, `./`, `//` and `.git` removed, and `..` refused.

### When detection runs

Detection runs in the worker, inside the same transaction that stores an intent or a batch of
actions. It compares the session with every other live session in the tenant. "Live" means active
and heard from in the last 15 minutes.

### What counts as an overlap

| Kind            | Severity | When                                                                                                                                |
| --------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `same_lines`    | high     | Same file, and the changed line ranges intersect: a merge conflict is likely.                                                       |
| `same_resource` | medium   | Same file or resource, but different lines.                                                                                         |
| `related_work`  | low      | Different files, but similar intents in the same repository (word overlap ≥ 0.4). This is a stand-in until intent embeddings exist. |

Some sessions never take part: private ones, opted-out members', and two sessions of the same
person.

### Alerting once

Each pair, kind and resource is one row, and each side is told once (`notified_a_at`,
`notified_b_at`). A stronger overlap (same lines, after same file) is a new row, so it alerts again.

### Delivery

1. A new overlap triggers `pg_notify('mm_alerts', tenant)`.
2. Every gateway instance sends the alerts its connected sessions haven't had, then marks them
   sent. Sessions that reconnect get what they missed.
3. The bridge queues the alert. Its next `PostToolUse` or `UserPromptSubmit` hook gives it to the
   agent once, in one sentence ("Conflict likely: Lior is changing the same lines of …").

Agents without the bridge use `check_overlaps`. The other person is named using the same
visibility rules as presence.

### Result

In the end-to-end test, both bridges received the alert **0.5 s** after the overlapping edit:
real queue, worker, gateway and bridge processes. The target is 5 s.

## Skill quality gate

Every draft passes through four checks before a reviewer sees it:

1. **Re-scan.** Secrets and personal data are removed again. Any phrasing aimed at the agent that
   will read the skill ("ignore previous instructions", "you are now", "do not tell the user"…)
   rejects the draft. Skills are fed to agents, so this matters.
2. **Verify** (Claude Sonnet, `skills.verify`, no tools). Each step is judged against the redacted
   text of the tasks it cites. A step is supported only if that work shows someone doing it.
   Unsupported steps are dropped; fewer than two left rejects the draft.
3. **Rubric** (Claude Haiku, `skills.rubric`). Specificity, actionability, groundedness,
   generality and safety are scored 1–5. Every score must be at least 3, with a mean of at least
   3.5.
4. **Dedupe.** The draft's practice key (its meaningful words) is compared with existing skills
   in the same category. When the words overlap by at least 0.5, Claude decides: **same** (a new
   version with merged evidence, back to review), **variant** (a new skill linked to the other) or
   **different** (a new skill).

Skills start as `in_review`. Each version is immutable: the app role can insert versions, but
never update or delete them.

## Prompt gate in CI

- **Fingerprints.** `evals/prompts.lock.json` holds a fingerprint of each gated prompt: its
  system text, a rendered sample and its output schema. Changing a prompt without bumping its
  version fails CI. A deliberate change is a version bump followed by `pnpm --filter @mm/skills
eval:lock`.
- **Golden cases.** 30 cases cover five practices, in four shapes:
  - a clear practice, at three cohort sizes;
  - a practice shown by only some successes;
  - a practice with an injected instruction hidden in a summary;
  - no practice at all.

  The deterministic graders are themselves tested: they must pass an ideal answer and fail
  leaking, wrongly cited and invented ones.

- **Live results.** `pnpm --filter @mm/skills eval` runs the cases against Claude on Bedrock and
  records a pass rate per prompt version. Once `evals/policy.json` sets
  `require_live_results: true`, a prompt version without a passing live result (at least 90%)
  fails CI. It is off until CI can reach Bedrock, and the gate prints a warning saying so.
