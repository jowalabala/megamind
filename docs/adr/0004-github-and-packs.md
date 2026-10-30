# ADR 0004: GitHub connector, domain packs and categorization

**Status:** accepted, week 4. Tested against a fake GitHub API; not yet run against GitHub.

## Decision

### GitHub data comes from one path

The GitHub App has read-only access.

- **Backfill.** The worker lists the installation's repositories. It then fetches pull requests
  through GraphQL, 25 per job, newest first, back 12 months.
- **Webhooks.** A webhook is verified (HMAC over the raw body), mapped to its tenant through the
  installation id, and reduced to a pointer such as "sync PR 12 of acme/api". The worker then
  fetches that PR's current state with the same GraphQL query the backfill uses.

Webhook payloads are never stored, and there is no raw copy of GitHub data to keep or erase.
GitHub stays the source of truth.

### A PR is a task

Each PR becomes one task with source `github`. Its id derives from the repository id and the PR
number, so re-syncs update it in place.

- **Text.** Titles, descriptions and branch names are redacted like everything else.
- **Facts.** The rest goes into `github_pull_requests` as metadata: size, files, reviews, labels,
  CI state and linked issues. It never holds diffs or file contents.
- **The lake.** A PR's task row goes to the lake once, when it is first closed or merged.

### Who wrote it

PR authors are keyed by GitHub's numeric user id (`github:<id>`), never by login. A member is
credited only after they link their account. Linking is an OAuth round trip, from install or
from Settings → Integrations, and it claims the PRs already captured under that id.

Other rules:

- **Bots** are keyed by name.
- **Opted-out members:** PRs by a linked member who opted out are not imported.
- **Erasure** removes both the member's rows and the rows keyed by their GitHub id, in Postgres
  and in the lake.

### The installation must be yours

An installation id in a callback URL is not proof of anything. The callback therefore exchanges
the one-time OAuth code, and accepts the installation only if GitHub lists it among the user's
own installations. The user token is used once and then discarded. An installation can belong
to one tenant only; a unique index enforces this.

### Packs and categories

A pack is YAML. It holds:

- categories, each with simple rules: title regex, labels, branch, files, bot author;
- the features to extract;
- the metrics week 5 will compute.

The categorizer uses the first rule that matches, then the agent's own hint, then Claude Haiku.
The model gets the redacted text as untrusted input, has no tools, and must answer with a
category from the pack; anything else falls back. Its confidence is capped at 0.85.

Every decision is stored on the task and appended to the lake table `task_categories`, so
re-categorizing never rewrites history.

## Why

- **GraphQL:** one query per 25 PRs, with reviews, files and CI included. REST needs about five
  calls per PR.
- **Rules first:** most PRs follow conventions (conventional commits, labels, bots), so rules
  are free, instant and explainable. The model handles the remainder.

## Not yet verified against GitHub

- The GraphQL query: field names, node limits, and its cost on large repositories.
- The OAuth setup and callback, with "Request user authorization during installation" turned on.
- How webhook traffic and backfill share the rate limit on a real organization.
