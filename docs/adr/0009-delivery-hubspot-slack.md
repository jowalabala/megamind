# ADR 0009: Skill delivery, measurement, Slack and HubSpot

**Status:** accepted, week 9.

## Delivering skills

Agents only ever receive a skill's **approved version** (`skills.approved_version`), and never a
retired skill. A newer version that is waiting for review changes nothing for agents until a
reviewer approves it.

There are three ways to receive skills, with the same rules for all:

- **MCP tools**, on the remote server and the bridge:
  - `search_skills` searches approved versions;
  - `get_skill` returns one approved version, or says the skill is retired or not approved yet;
  - `record_skill_use` records that an agent used a skill.
- **`log_task` has a `skills_used` field**, so an agent can report the skills it followed in the
  same call that logs the task.
- **SKILL.md files.** The bridge writes the approved skills in the categories a member follows to
  `~/.claude/skills/mm-*/SKILL.md`, at session start and on `mm skills sync`. This is Claude
  Code's own skill format.
  - It removes them again when a skill is retired or the member unfollows its category.
  - It only touches folders it created itself, which hold a `.mastermind` marker file.
  - The web app offers the same file as a download.

**Following a category** (`skill_subscriptions`) controls only two things: what the bridge
installs for that member, and the Slack messages they get about skill changes. Every agent can
still search all approved skills.

**Scopes.** Reading skills needs the `skills:read` scope, which new keys now get by default.
Existing keys that already had `history:read` were given `skills:read` too: approved skills are
less sensitive than team history.

## Measurement and the degradation flag

Once an hour, each served skill is checked. The question is whether work that followed it did
better than work that didn't.

- **The work compared:** judged tasks in the skill's category from the last 90 days.
- **Which tasks count as "followed":**
  - a task with a recorded use of the served version counts;
  - so does a task that an agent's task is attributed to with confidence ≥ 0.7, if the agent's
    task recorded the use;
  - "consulted" (read but not followed) doesn't count.
- **The interval:** Agresti-Caffo 95% for the difference in success rates. It stays sensible
  with small or all-or-nothing samples.
- **Minimum sample:** the comparison needs at least 10 tasks on each side.
- **Storage:** every result is stored (`skill_measurements`) and shown on the skill's page.

If the **whole interval is below zero**, the skill is flagged:

- `skills.flagged_at` and a plain-language reason are set;
- it shows in the review queue;
- its reviewers get a Slack DM;
- an audit event is written.

A flag never retires anything by itself, because measurement is a comparison and not proof of
cause. A person decides: retire it, roll it back, or keep serving it. Any review action clears
the flag.

## Notifications and Slack

Notifications go into an outbox table (`notifications`), in the same transaction as the event
they report. The worker sends them every 5 seconds.

**What triggers a notification:**

- a channel request: each person who still has to approve;
- a skill version entering review: its reviewers;
- a flag: its reviewers;
- a skill being approved, rolled back or retired: the people who follow its category.

**Without a Slack connection**, notifications are marked skipped. The web app shows the same
approvals and queues.

**The Slack app.** It asks for `chat:write`, `users:read` and `users:read.email`. It sends direct
messages only and reads no channels or messages.

- **Matching people.** Members are matched to Slack users by their work email
  (`users.lookupByEmail`) inside the tenant's own connected workspace. The admin who installs the
  app is matched by the OAuth result itself.
- **Deviation from the plan:** the plan listed only `chat:write`. Looking people up by email
  needs the other two scopes.
- **Token storage:** the bot token is sealed by the token vault before it is stored.

### Approving a channel from Slack

A channel request DM has Approve and Decline buttons. A click reaches
`POST /webhooks/slack/interactions`, which:

1. **checks the signing secret** (v0 HMAC over the raw body) and refuses anything older than five
   minutes, so captured requests can't be replayed;
2. **finds the tenant** from the Slack workspace (team) id, through `mm_resolve_connection`;
3. **finds the member** by their remembered Slack user id. Unknown Slack users can't decide for
   anyone; they're told to use the web app;
4. **calls the same `decide()` as the web app**, with `via: "slack"`. It is audited the same way.

Agents still can't approve. An agent has no Slack signing secret, and agent keys aren't accepted
on this endpoint. The original message is updated through Slack's `response_url`, and only
Slack's own origin is accepted, so a forged URL can't make the API call elsewhere.

## HubSpot

**OAuth:**

- the scopes are read-only: `automation.sequences.read`, `crm.objects.owners.read` and
  `crm.objects.contacts.read`;
- the refresh token is sealed and stored;
- access tokens (30 minutes) are kept in memory only.

**One sequence → one task** (source `hubspot`):

- **Kept:** the sequence name (redacted), its step counts, and the ref `hubspot:sequence:<id>`.
- **Credit:** sequence owners are matched to members by work email inside the tenant's own
  portal. Opted-out members' sequences aren't stored.
- **Not fetched:** email templates are not fetched. The "how" behind a sequence comes from the
  agent work attributed to it.

**Outcomes.** HubSpot's sequences API doesn't report replies or meetings. So for each sequence,
Master Mind searches contacts whose _latest_ sequence is this one. It requests three date
properties only:

- the enrolment date;
- the last sales-email reply;
- the last meeting booked.

From those it counts **how many replied or booked after enrolling**. Only the counts are kept;
contact ids are dropped as each page is read.

Metrics (`sequence.reply_rate`, `sequence.meeting_rate`, with n = enrolled contacts) are written
**once**, when both of these hold:

- the sequence is 30 days old;
- it has at least 20 enrolments that are 14 days old.

**Limitations:**

- A contact who was later enrolled in another sequence counts only for that later one.
- HubSpot's search returns at most 10,000 contacts per sequence.

**The revenue pack** (`packs/builtin.ts`) categorizes sequences as prospecting, follow-up or
other, and judges them against the team's own history:

- **success:** reply rate at or above the 75th percentile of earlier sequences;
- **failure:** below the 25th percentile;
- **minimum history:** at least 10 earlier sequences.

Marketing emails, deals and the rest of the revenue pack come in week 10.

**Not verified live.** The connector follows HubSpot's public docs (v4 sequences, v3 owners and
contact search, v1 OAuth). It is tested against a local fake built from those docs, not against
a real portal. Before the pilot, connect a real portal and check the paths, the step
`actionType` values and the contact property names.

## Attribution

Attribution links an agent's task to the connector task it produced, such as a PR or a
sequence. That way the agent's account of how it did the work meets the outcome measured on the
result. Links are stored in `task_attributions`.

1. **By reference (confidence 1.0).** The agent's `external_refs` contains the same ref as the
   connector task.
2. **By heuristic.** All three must hold:
   - same member;
   - the result was created between 24 hours before and 72 hours after the agent finished;
   - the titles overlap.

   Confidence is 0.4 + 0.25 × time closeness + 0.35 × title similarity. Matches below 0.5 aren't
   stored. Those below 0.7 are kept but not used for learning or measurement.

## Token vault

`@mm/vault` seals OAuth tokens:

- **In AWS: KMS**, with the tenant and purpose (e.g. `slack:<connection id>:bot_token`) as the
  encryption context. A value copied to another tenant or connection won't decrypt, and
  CloudTrail logs every decrypt.
- **In development: AES-GCM**, with a key derived per tenant.

**Who holds which permission:** the web app can only encrypt (it seals at install time). The
worker can encrypt and decrypt (it calls the providers and re-seals rotated tokens). The API
holds neither.
