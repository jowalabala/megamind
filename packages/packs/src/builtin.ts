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
  - { id: ci.first_pass, description: CI passed on the first run., unit: boolean, better: higher }
  - { id: pr.reverted, description: Reverted within 30 days of merge., unit: boolean, better: lower }
  - { id: pr.escaped_defect, description: A later bug fix traces back to this PR., unit: boolean, better: lower }
  - { id: pr.review_rounds, description: Rounds of requested changes., unit: count, better: lower }
  - { id: pr.hours_to_merge, description: Hours from opening to merge., unit: hours, better: lower }
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
