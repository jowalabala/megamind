-- Capture: agents and their keys, agent sessions, tasks and their evidence, outcome
-- metrics and agent action events. Text columns ending in _redacted only ever hold
-- output of @mm/privacy; raw payloads live in the encrypted bronze bucket for 30 days.

CREATE TYPE capture_source AS ENUM ('mcp', 'bridge', 'github', 'hubspot', 'csv', 'ui');
CREATE TYPE task_state AS ENUM ('logged', 'categorized', 'awaiting_outcome', 'judged', 'excluded');
CREATE TYPE action_kind AS ENUM ('tool_call', 'edit', 'command', 'message', 'outcome');

-- An agent always acts for one human member.
CREATE TABLE agent_identities (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  member_id            uuid NOT NULL,
  name                 text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  kind                 text NOT NULL CHECK (kind IN ('claude_code', 'cursor', 'chatgpt', 'copilot', 'custom', 'bridge')),
  -- First characters of the key, shown in the UI so people can tell keys apart.
  key_prefix           text NOT NULL CHECK (key_prefix ~ '^mm_(live|test)_[A-Za-z0-9]{4,12}$'),
  scopes               text[] NOT NULL DEFAULT '{capture:write}'
                         CHECK (scopes <@ ARRAY['capture:write', 'skills:read', 'collab']::text[]),
  created_by_member_id uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_used_at         timestamptz,
  revoked_at           timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES members (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by_member_id) REFERENCES members (tenant_id, id)
    ON DELETE SET NULL (created_by_member_id)
);
CREATE INDEX agent_identities_member_idx ON agent_identities (tenant_id, member_id);

-- Key hashes, looked up before any tenant context exists (by mm_authenticate_agent only).
-- Like tenants, RLS is enabled but not FORCED so that SECURITY DEFINER function can read it.
-- mm_app can insert and delete keys inside its own tenant, but can never read a hash back.
CREATE TABLE agent_keys (
  key_hash          text PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  tenant_id         uuid NOT NULL,
  agent_identity_id uuid NOT NULL UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, agent_identity_id) REFERENCES agent_identities (tenant_id, id) ON DELETE CASCADE
);

-- One run of an agent (a Claude Code session, a chat thread).
CREATE TABLE agent_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  agent_identity_id uuid NOT NULL,
  member_id         uuid NOT NULL,
  client_session_id text NOT NULL CHECK (length(client_session_id) BETWEEN 1 AND 200),
  context_redacted  jsonb NOT NULL DEFAULT '{}',
  private           boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  started_at        timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, agent_identity_id, client_session_id),
  FOREIGN KEY (tenant_id, agent_identity_id) REFERENCES agent_identities (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, member_id) REFERENCES members (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE tasks (
  -- Assigned when the API accepts the task, so the agent gets it back immediately.
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  member_id         uuid NOT NULL,
  agent_identity_id uuid,
  agent_session_id  uuid,
  source            capture_source NOT NULL,
  idempotency_key   text CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  title_redacted    text NOT NULL CHECK (length(title_redacted) BETWEEN 1 AND 1000),
  summary_redacted  text NOT NULL DEFAULT '' CHECK (length(summary_redacted) <= 40000),
  category_hint     text CHECK (length(category_hint) <= 100),
  features          jsonb NOT NULL DEFAULT '{}',
  redaction_counts  jsonb NOT NULL DEFAULT '{}',
  state             task_state NOT NULL DEFAULT 'logged',
  started_at        timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, member_id, idempotency_key),
  FOREIGN KEY (tenant_id, member_id) REFERENCES members (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, agent_identity_id) REFERENCES agent_identities (tenant_id, id)
    ON DELETE SET NULL (agent_identity_id),
  FOREIGN KEY (tenant_id, agent_session_id) REFERENCES agent_sessions (tenant_id, id)
    ON DELETE SET NULL (agent_session_id)
);
CREATE INDEX tasks_tenant_created_idx ON tasks (tenant_id, created_at DESC);
CREATE INDEX tasks_member_idx ON tasks (tenant_id, member_id);

CREATE TABLE artifacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  task_id          uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('text', 'diff', 'email', 'document', 'link', 'other')),
  content_redacted text CHECK (length(content_redacted) <= 200000),
  uri_redacted     text CHECK (length(uri_redacted) <= 2000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (content_redacted IS NOT NULL OR uri_redacted IS NOT NULL),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX artifacts_task_idx ON artifacts (tenant_id, task_id);

-- Pointers to work in other systems, e.g. github:pr:acme/api#123. The key to attribution.
CREATE TABLE external_refs (
  tenant_id  uuid NOT NULL,
  task_id    uuid NOT NULL,
  ref        text NOT NULL CHECK (length(ref) <= 500 AND ref ~ '^[a-z][a-z0-9_]{0,30}:[a-z][a-z0-9_]{0,30}:\S+$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, task_id, ref),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX external_refs_ref_idx ON external_refs (tenant_id, ref);

CREATE TABLE metric_observations (
  -- Assigned when the API accepts the report, so retries can't double count.
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  task_id           uuid NOT NULL,
  metric_key        text NOT NULL CHECK (metric_key ~ '^[a-z][a-z0-9_.]{0,99}$'),
  value             double precision NOT NULL CHECK (value NOT IN ('NaN', 'Infinity', '-Infinity')),
  n                 integer NOT NULL DEFAULT 1 CHECK (n > 0),
  source            capture_source NOT NULL,
  agent_identity_id uuid,
  note_redacted     text CHECK (length(note_redacted) <= 4000),
  observed_at       timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, agent_identity_id) REFERENCES agent_identities (tenant_id, id)
    ON DELETE SET NULL (agent_identity_id)
);
CREATE INDEX metric_observations_task_idx ON metric_observations (tenant_id, task_id);

-- The cleaned record of one agent action. Hot copy here (90 days); full history in the lake.
CREATE TABLE action_events (
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- Client-generated event id, for de-duplication. Unique per tenant only.
  id               uuid NOT NULL,
  session_id       uuid NOT NULL,
  member_id        uuid NOT NULL,
  task_id          uuid,
  kind             action_kind NOT NULL,
  summary_redacted text NOT NULL CHECK (length(summary_redacted) <= 4000),
  resources        text[] NOT NULL DEFAULT '{}' CHECK (cardinality(resources) <= 200),
  occurred_at      timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES agent_sessions (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, member_id) REFERENCES members (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE SET NULL (task_id)
);
CREATE INDEX action_events_session_time_idx ON action_events (tenant_id, session_id, occurred_at);
CREATE INDEX action_events_time_idx ON action_events (tenant_id, occurred_at DESC);
CREATE INDEX action_events_resources_idx ON action_events USING gin (resources);

-- Row-level security -----------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_identities', 'agent_sessions', 'tasks', 'artifacts',
                           'external_refs', 'metric_observations', 'action_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I
                      USING (tenant_id = mm_current_tenant())
                      WITH CHECK (tenant_id = mm_current_tenant())', t);
  END LOOP;
END $$;

ALTER TABLE agent_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_keys
  USING (tenant_id = mm_current_tenant())
  WITH CHECK (tenant_id = mm_current_tenant());

-- Grants ------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_identities, agent_sessions, tasks, artifacts,
  external_refs TO mm_app;
GRANT SELECT, INSERT, DELETE ON metric_observations, action_events TO mm_app;
-- The app can add and delete keys, but can never read a hash back.
-- (DELETE ... WHERE needs SELECT on the filtered columns, so those are granted.)
GRANT INSERT, DELETE ON agent_keys TO mm_app;
GRANT SELECT (tenant_id, agent_identity_id, created_at) ON agent_keys TO mm_app;

-- Agent authentication -------------------------------------------------------------

-- Resolves a key hash to its agent. Returns no row for unknown or revoked keys.
-- Also reports the member's capture opt-out so ingest can drop data before storing anything.
CREATE FUNCTION mm_authenticate_agent(p_key_hash text)
RETURNS TABLE (tenant_id uuid, agent_id uuid, member_id uuid, scopes text[], capture_opt_out boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant uuid;
  v_agent uuid;
BEGIN
  SELECT k.tenant_id, k.agent_identity_id INTO v_tenant, v_agent
    FROM agent_keys k WHERE k.key_hash = p_key_hash;
  IF v_tenant IS NULL THEN
    RETURN;
  END IF;
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  -- Throttled so a busy agent doesn't rewrite the row on every call.
  UPDATE agent_identities a SET last_used_at = now()
    WHERE a.id = v_agent AND a.revoked_at IS NULL
      AND (a.last_used_at IS NULL OR a.last_used_at < now() - interval '1 minute');
  RETURN QUERY
    SELECT a.tenant_id, a.id, a.member_id, a.scopes, m.capture_opt_out
      FROM agent_identities a
      JOIN members m ON m.tenant_id = a.tenant_id AND m.id = a.member_id
     WHERE a.id = v_agent AND a.revoked_at IS NULL;
END
$$;
REVOKE ALL ON FUNCTION mm_authenticate_agent(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mm_authenticate_agent(text) TO mm_app;
