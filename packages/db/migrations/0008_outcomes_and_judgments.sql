-- Week 5: PR outcome signals, revert/fix links, and judgments.

-- Signals computed at sync from GitHub metadata. The PR body and commit messages are read in
-- memory to find these and are never stored.
ALTER TABLE github_pull_requests
  ADD COLUMN base_sha text CHECK (base_sha ~ '^[0-9a-f]{40}$'),
  -- CI state of the first commit pushed: did it pass the first time?
  ADD COLUMN first_ci_state text,
  -- PR numbers and commit SHAs this PR says it reverts ("Reverts acme/api#12",
  -- "This reverts commit <sha>").
  ADD COLUMN reverts_prs integer[] NOT NULL DEFAULT '{}',
  ADD COLUMN reverts_shas text[] NOT NULL DEFAULT '{}',
  -- Commits whose message mentions resolving conflicts, and merges from the base branch.
  ADD COLUMN conflict_commits integer NOT NULL DEFAULT 0,
  ADD COLUMN base_merge_commits integer NOT NULL DEFAULT 0,
  -- Defect tracing (SZZ) ran for this PR (it is a merged bug fix).
  ADD COLUMN szz_done_at timestamptz,
  -- Every outcome metric is final (its observation window has passed).
  ADD COLUMN metrics_final_at timestamptz;

-- "PR A reverts PR B" and "fix PR A changed lines that PR B introduced".
CREATE TABLE github_pr_links (
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  from_task_id uuid NOT NULL,
  to_task_id   uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('reverts', 'fixes')),
  -- e.g. { "files": 2, "lines": 14 } for fixes. Counts only, never code.
  evidence     jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, from_task_id, to_task_id, kind),
  CHECK (from_task_id <> to_task_id),
  FOREIGN KEY (tenant_id, from_task_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, to_task_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX github_pr_links_to_idx ON github_pr_links (tenant_id, to_task_id, kind);

-- One verdict per task per judge ruleset version. Deterministic: the same data and the same
-- ruleset always produce the same row.
CREATE TABLE judgments (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  task_id          uuid NOT NULL,
  pack             text NOT NULL,
  ruleset_version  integer NOT NULL CHECK (ruleset_version > 0),
  category         text,
  verdict          text NOT NULL CHECK (verdict IN ('success', 'failure', 'neutral', 'inconclusive')),
  -- [{ "rule", "metric", "value", "threshold", "result" }]
  reasons          jsonb NOT NULL DEFAULT '[]',
  -- Baseline used, e.g. { "pr.review_rounds": { "p50": 1, "p75": 2, "n": 48 } }
  baseline         jsonb NOT NULL DEFAULT '{}',
  -- Hash of every input, so a replay can prove it reached the same verdict from the same data.
  input_hash       text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  judged_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, task_id, pack, ruleset_version),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX judgments_verdict_idx ON judgments (tenant_id, pack, category, verdict);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['github_pr_links', 'judgments']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I
                      USING (tenant_id = mm_current_tenant())
                      WITH CHECK (tenant_id = mm_current_tenant())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, DELETE ON github_pr_links TO mm_app;
GRANT SELECT, INSERT, UPDATE ON judgments TO mm_app;
-- Computed metrics are recomputed in place (same deterministic id).
GRANT UPDATE (value, n, observed_at) ON metric_observations TO mm_app;

ALTER TABLE lake_outbox DROP CONSTRAINT lake_outbox_lake_table_check;
ALTER TABLE lake_outbox ADD CONSTRAINT lake_outbox_lake_table_check
  CHECK (lake_table IN ('actions', 'tasks', 'metric_observations', 'task_categories', 'judgments'));
