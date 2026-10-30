-- Week 4: the GitHub connector, PRs as tasks, and task categories.

-- Members --------------------------------------------------------------------------

-- A member's GitHub account, linked by an OAuth round trip (never typed in). The numeric
-- id is stable across renames and identifies nobody outside GitHub.
ALTER TABLE members ADD COLUMN github_user_id bigint CHECK (github_user_id > 0);
CREATE UNIQUE INDEX members_github_user_idx ON members (tenant_id, github_user_id)
  WHERE github_user_id IS NOT NULL;

-- Connections ------------------------------------------------------------------------

-- An installed integration. For GitHub, external_id is the App installation id; tokens are
-- minted per request from the App key, so nothing secret is stored here.
-- Like tenants, RLS is enabled but not forced: webhooks resolve installation -> tenant
-- through mm_resolve_connection() before any tenant context exists.
CREATE TABLE connections (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  provider             text NOT NULL CHECK (provider IN ('github')),
  external_id          text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 100),
  account_login        text CHECK (length(account_login) <= 100),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'removed')),
  created_by_member_id uuid,
  backfill_status      text NOT NULL DEFAULT 'pending'
                         CHECK (backfill_status IN ('pending', 'running', 'done', 'failed')),
  -- Per-repository progress: { "<repo id>": { "name": "...", "done": bool, "prs": n } }
  backfill_state       jsonb NOT NULL DEFAULT '{}',
  backfill_error       text CHECK (length(backfill_error) <= 2000),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- An installation belongs to exactly one tenant, ever.
  UNIQUE (provider, external_id),
  FOREIGN KEY (tenant_id, created_by_member_id) REFERENCES members (tenant_id, id)
    ON DELETE SET NULL (created_by_member_id)
);

ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connections
  USING (tenant_id = mm_current_tenant())
  WITH CHECK (tenant_id = mm_current_tenant());
GRANT SELECT, INSERT, UPDATE ON connections TO mm_app;

CREATE FUNCTION mm_resolve_connection(p_provider text, p_external_id text)
RETURNS TABLE (tenant_id uuid, connection_id uuid, status text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.tenant_id, c.id, c.status FROM connections c
   WHERE c.provider = p_provider AND c.external_id = p_external_id
$$;
REVOKE ALL ON FUNCTION mm_resolve_connection(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mm_resolve_connection(text, text) TO mm_app;

-- Tasks from connectors -----------------------------------------------------------------

-- A PR whose author hasn't linked their GitHub account has no member, only an actor key
-- ("github:<numeric user id>"). Linking fills member_id in.
ALTER TABLE tasks ALTER COLUMN member_id DROP NOT NULL;
ALTER TABLE tasks ADD COLUMN actor_key text CHECK (actor_key ~ '^[a-z]+:[A-Za-z0-9_-]{1,64}$');
ALTER TABLE tasks ADD CONSTRAINT tasks_actor_check CHECK (member_id IS NOT NULL OR actor_key IS NOT NULL);
ALTER TABLE tasks ADD COLUMN connection_id uuid;
ALTER TABLE tasks ADD CONSTRAINT tasks_connection_fk FOREIGN KEY (tenant_id, connection_id)
  REFERENCES connections (tenant_id, id) ON DELETE SET NULL (connection_id);
CREATE INDEX tasks_actor_idx ON tasks (tenant_id, actor_key) WHERE actor_key IS NOT NULL;

-- Categories, set by the categorizer from the task's domain pack.
ALTER TABLE tasks ADD COLUMN pack text CHECK (pack ~ '^[a-z][a-z0-9_]{0,31}$');
ALTER TABLE tasks ADD COLUMN category text CHECK (category ~ '^[a-z][a-z0-9_]{0,63}$');
ALTER TABLE tasks ADD COLUMN category_source text
  CHECK (category_source IN ('rule', 'hint', 'llm', 'fallback'));
ALTER TABLE tasks ADD COLUMN category_confidence real
  CHECK (category_confidence >= 0 AND category_confidence <= 1);
CREATE INDEX tasks_category_idx ON tasks (tenant_id, pack, category);

-- GitHub pull request facts, one row per PR task. Metadata only: no diffs, no file
-- contents. Branch names are redacted (they often contain people's names).
CREATE TABLE github_pull_requests (
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  task_id           uuid NOT NULL,
  connection_id     uuid,
  repo_id           bigint NOT NULL,
  repo              text NOT NULL CHECK (repo ~ '^[a-z0-9._-]+/[a-z0-9._-]+$'),
  number            integer NOT NULL CHECK (number > 0),
  author_key        text NOT NULL,
  author_is_bot     boolean NOT NULL DEFAULT false,
  state             text NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
  draft             boolean NOT NULL DEFAULT false,
  base_ref          text NOT NULL,
  head_ref_redacted text NOT NULL,
  head_sha          text CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  merge_commit_sha  text CHECK (merge_commit_sha ~ '^[0-9a-f]{40}$'),
  additions         integer NOT NULL DEFAULT 0,
  deletions         integer NOT NULL DEFAULT 0,
  changed_files     integer NOT NULL DEFAULT 0,
  commits           integer NOT NULL DEFAULT 0,
  labels            text[] NOT NULL DEFAULT '{}',
  -- [{ "path", "additions", "deletions" }], first 100 files.
  files             jsonb NOT NULL DEFAULT '[]',
  -- [{ "state", "author_key", "submitted_at" }]
  reviews           jsonb NOT NULL DEFAULT '[]',
  closing_issues    integer[] NOT NULL DEFAULT '{}',
  ci_state          text,
  opened_at         timestamptz NOT NULL,
  merged_at         timestamptz,
  closed_at         timestamptz,
  gh_updated_at     timestamptz NOT NULL,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  -- Set once the closed PR's task row has gone to the lake outbox.
  lake_emitted_at   timestamptz,
  PRIMARY KEY (tenant_id, task_id),
  UNIQUE (tenant_id, repo_id, number),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id)
    ON DELETE SET NULL (connection_id)
);
CREATE INDEX github_pull_requests_repo_idx ON github_pull_requests (tenant_id, repo, merged_at);

ALTER TABLE github_pull_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_pull_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON github_pull_requests
  USING (tenant_id = mm_current_tenant())
  WITH CHECK (tenant_id = mm_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON github_pull_requests TO mm_app;

-- Lake and erasure ----------------------------------------------------------------------

ALTER TABLE lake_outbox DROP CONSTRAINT lake_outbox_lake_table_check;
ALTER TABLE lake_outbox ADD CONSTRAINT lake_outbox_lake_table_check
  CHECK (lake_table IN ('actions', 'tasks', 'metric_observations', 'task_categories'));

-- Connector data is keyed by actor (e.g. GitHub id), not only by member: erasure removes both.
ALTER TABLE erasure_requests ADD COLUMN subject_actor_keys text[] NOT NULL DEFAULT '{}';
