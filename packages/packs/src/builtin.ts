// Packs shipped with Master Mind. YAML, like the packs admins will write, kept in TypeScript
// strings so they bundle into the services.

export const ENGINEERING_PACK = `
id: engineering
version: 1
name: Engineering
description: Code changes, from GitHub pull requests and coding agents.
applies_to:
  sources: [github]
  ref_systems: [github]
  code_sessions: true

# Order matters: the first category with a matching rule wins.
categories:
  - id: revert
    name: Revert
    description: Undoes an earlier change.
    rules:
      - title: '^revert\\b'

  - id: dependencies
    name: Dependencies
    description: Version bumps and dependency updates, usually by a bot.
    rules:
      - title: '^(chore|build|fix)\\(deps(-dev)?\\)'
      - labels_any: [dependencies, deps]
      - author_bot: true
        title: '^(bump|update|upgrade) '

  - id: security
    name: Security fix
    description: Fixes a vulnerability or hardens security.
    rules:
      - title: '^(sec|security)(\\(.+\\))?!?:'
      - labels_any: [security, vulnerability]

  - id: bugfix
    name: Bug fix
    description: Fixes incorrect behaviour.
    rules:
      - title: '^(fix|bugfix|hotfix)(\\(.+\\))?!?:'
      - labels_any: [bug, bugfix, hotfix, regression]
      - branch: '^(fix|bugfix|hotfix|bug)[/_-]'

  - id: performance
    name: Performance
    description: Makes something faster or cheaper without changing behaviour.
    rules:
      - title: '^perf(\\(.+\\))?!?:'
      - labels_any: [performance, perf]

  - id: refactor
    name: Refactor
    description: Restructures code without changing behaviour.
    rules:
      - title: '^refactor(\\(.+\\))?!?:'
      - labels_any: [refactor, refactoring, tech-debt]

  - id: tests
    name: Tests
    description: Adds or changes tests only.
    rules:
      - title: '^tests?(\\(.+\\))?!?:'
      - files_all:
          - '(^|/)(tests?|__tests__|specs?)/'
          - '\\.(test|spec)\\.[a-z0-9]+$'
          - '_test\\.(go|py|rb)$'
          - '(^|/)test_[^/]+\\.py$'

  - id: docs
    name: Documentation
    description: Documentation only.
    rules:
      - title: '^docs?(\\(.+\\))?!?:'
      - files_all: ['\\.(md|mdx|rst|adoc|txt)$', '^docs?/']

  - id: ci
    name: CI
    description: Build and CI pipeline changes.
    rules:
      - title: '^ci(\\(.+\\))?!?:'
      - files_all: ['^\\.github/', '^\\.circleci/', '(^|/)Jenkinsfile$', '^\\.gitlab-ci\\.ya?ml$']

  - id: infra
    name: Infrastructure
    description: Infrastructure, deployment and environment configuration.
    rules:
      - title: '^(infra|ops|deploy)(\\(.+\\))?!?:'
      - files_all: ['\\.tf$', '^(infra|terraform|k8s|helm|deploy)/', '(^|/)Dockerfile$']

  - id: feature
    name: Feature
    description: Adds new behaviour or capability for users.
    rules:
      - title: '^feat(ure)?(\\(.+\\))?!?:'
      - labels_any: [feature, enhancement]
      - branch: '^(feat|feature)[/_-]'

  - id: chore
    name: Chore
    description: Maintenance with no user-visible change (formatting, tooling, cleanup).
    rules:
      - title: '^(chore|build|style)(\\(.+\\))?!?:'

  - id: other
    name: Other
    description: Anything that fits none of the above.

fallback: other

features:
  - { id: size_lines, description: Lines added plus deleted. }
  - { id: files_changed, description: Number of files changed. }
  - { id: tests_touched, description: Whether any test file changed. }
  - { id: test_file_ratio, description: Share of changed files that are tests. }
  - { id: docs_only, description: Only documentation changed. }
  - { id: dirs_touched, description: Distinct top-level directories changed. }
  - { id: commits, description: Commits in the PR. }
  - { id: reviews, description: Reviews submitted. }
  - { id: reviewers, description: Distinct reviewers. }
  - { id: changes_requested, description: Reviews that requested changes. }
  - { id: hours_to_first_review, description: Hours from opening to the first review. }
  - { id: hours_to_merge, description: Hours from opening to merge. }
  - { id: has_linked_issue, description: The PR closes an issue. }
  - { id: agent_authored, description: An AI agent wrote or co-wrote it (trailer or bot). }
  - { id: draft, description: Opened as a draft. }

metrics:
  - { id: ci.first_pass, description: CI passed on the first commit pushed., unit: boolean, better: higher }
  - { id: pr.reverted, description: Reverted within 30 days of merge., unit: boolean, better: lower, window_days: 30 }
  - { id: pr.escaped_defect, description: A bug fix within 60 days traces back to this PR (SZZ)., unit: boolean, better: lower, window_days: 60 }
  - { id: pr.review_rounds, description: Reviews that requested changes., unit: count, better: lower }
  - { id: pr.hours_to_merge, description: Hours from opening to merge., unit: hours, better: lower }
  - { id: pr.merge_conflict, description: A commit resolved merge conflicts., unit: boolean, better: lower }

judge:
  version: 1
  requires: [pr.reverted, pr.escaped_defect]
  # Not judged: they say little about how well the work was done.
  skip_categories: [revert, dependencies, docs, chore]
  failure_if_any:
    - { metric: pr.reverted, op: eq, value: 1 }
    - { metric: pr.escaped_defect, op: eq, value: 1 }
  success_if_all:
    - { metric: ci.first_pass, op: eq, value: 1 }
    - { metric: pr.review_rounds, op: lte, baseline: p75 }
  baseline: { days: 180, min_samples: 20 }
`;

// Week 9 covers HubSpot sequences; marketing emails and deals come with the full revenue pack.
export const REVENUE_PACK = `
id: revenue
version: 1
name: Revenue
description: Sales and marketing work, from HubSpot and from agents working in it.
applies_to:
  sources: [hubspot]
  ref_systems: [hubspot]

categories:
  - id: prospecting_sequence
    name: Prospecting sequence
    description: A sequence that reaches out to new prospects (cold or outbound).
    rules:
      - labels_any: [sequence]
        title: '(cold|outbound|prospect|intro|first touch|new logo)'

  - id: follow_up_sequence
    name: Follow-up sequence
    description: A sequence that follows up with people already in conversation (demo, trial, event, re-engagement).
    rules:
      - labels_any: [sequence]
        title: '(follow[ -]?up|nurture|re-?engage|after|post[ -]|demo|trial|event|webinar|check[ -]?in)'

  - id: sequence
    name: Other sequence
    description: Any other sales sequence.
    rules:
      - labels_any: [sequence]

  - id: other
    name: Other
    description: Revenue work that isn't a sequence.

fallback: other

features:
  - { id: steps, description: Steps in the sequence. }
  - { id: email_steps, description: Automated or manual email steps. }
  - { id: task_steps, description: Task steps (calls, LinkedIn, manual work). }

metrics:
  - { id: sequence.reply_rate, description: Share of enrolled contacts who replied after enrolling., unit: ratio, better: higher, window_days: 30 }
  - { id: sequence.meeting_rate, description: Share of enrolled contacts who booked a meeting after enrolling., unit: ratio, better: higher, window_days: 30 }

judge:
  version: 1
  requires: [sequence.reply_rate]
  skip_categories: [other]
  failure_if_any:
    - { metric: sequence.reply_rate, op: lt, baseline: p25 }
  success_if_all:
    - { metric: sequence.reply_rate, op: gte, baseline: p75 }
  baseline: { days: 365, min_samples: 10 }
`;

export const GENERIC_PACK = `
id: generic
version: 1
name: General
description: Work that no specific pack covers. Admins add categories and metrics here.
categories:
  - id: other
    name: Other
    description: Any unit of work.
fallback: other
`;
