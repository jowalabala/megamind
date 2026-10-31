-- Week 9: skill delivery and measurement, notifications (Slack), HubSpot, attribution.

-- Integrations -------------------------------------------------------------------------------------

-- HubSpot portals and Slack workspaces are connections too. external_id is the HubSpot portal
-- id or the Slack team id; like GitHub installations, each belongs to one tenant, ever.
ALTER TABLE connections DROP CONSTRAINT connections_provider_check;
ALTER TABLE connections ADD CONSTRAINT connections_provider_check
  CHECK (provider IN ('github', 'hubspot', 'slack'));

-- OAuth tokens, sealed by the token vault (KMS in AWS) and bound to their tenant and connection.
-- The app role can write and read them back; nothing else stores secrets.
CREATE TABLE connection_secrets (
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('refresh_token', 'bot_token')),
  sealed        text NOT NULL CHECK (length(sealed) <= 8000),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id, kind),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id) ON DELETE CASCADE
);

-- Who a member is in Slack (for DMs and approval buttons) and in HubSpot (for credit).
-- Both are matched by the member's verified work email, inside the tenant's own workspace.
ALTER TABLE members ADD COLUMN slack_user_id text CHECK (slack_user_id ~ '^[A-Z0-9]{2,32}$');
ALTER TABLE members ADD COLUMN hubspot_user_id bigint;
CREATE UNIQUE INDEX members_slack_user_idx ON members (tenant_id, slack_user_id) WHERE slack_user_id IS NOT NULL;
CREATE UNIQUE INDEX members_hubspot_user_idx ON members (tenant_id, hubspot_user_id) WHERE hubspot_user_id IS NOT NULL;

-- One HubSpot sequence -> one task. Counts only: no contact ids, names or emails are kept.
CREATE TABLE hubspot_sequences (
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  task_id          uuid NOT NULL,
  connection_id    uuid,
  sequence_id      text NOT NULL CHECK (sequence_id ~ '^[0-9]{1,30}$'),
  owner_user_id    bigint,
  steps            integer NOT NULL DEFAULT 0,
  email_steps      integer NOT NULL DEFAULT 0,
  task_steps       integer NOT NULL DEFAULT 0,
  created_at_hs    timestamptz NOT NULL,
  updated_at_hs    timestamptz NOT NULL,
  -- Latest counts over mature enrollments: { enrolled, replied, meetings, as_of }.
  counts           jsonb NOT NULL DEFAULT '{}',
  synced_at        timestamptz NOT NULL DEFAULT now(),
  metrics_final_at timestamptz,
  PRIMARY KEY (tenant_id, task_id),
  UNIQUE (tenant_id, connection_id, sequence_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id) ON DELETE SET NULL (connection_id)
);

-- Attribution: which connector task (a PR, a sequence) an agent's task produced.
-- reference = the agent named it (external_refs); heuristic = same person, close in time,
-- similar title. Below 0.7 confidence an attribution is kept but not used for learning.
CREATE TABLE task_attributions (
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  task_id        uuid NOT NULL,
  target_task_id uuid NOT NULL,
  method         text NOT NULL CHECK (method IN ('reference', 'heuristic')),
  confidence     real NOT NULL CHECK (confidence > 0 AND confidence <= 1),
  evidence       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, task_id, target_task_id),
  CHECK (task_id <> target_task_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, target_task_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX task_attributions_target_idx ON task_attributions (tenant_id, target_task_id);

-- Skill delivery ----------------------------------------------------------------------------------

-- "Send me approved skills for this kind of work." category '*' means the whole pack.
CREATE TABLE skill_subscriptions (
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  member_id  uuid NOT NULL,
  pack       text NOT NULL CHECK (pack ~ '^[a-z][a-z0-9_]{0,31}$'),
  category   text NOT NULL CHECK (category = '*' OR category ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, member_id, pack, category),
  FOREIGN KEY (tenant_id, member_id) REFERENCES members (tenant_id, id) ON DELETE CASCADE
);

-- An agent followed (or consulted) a skill while doing a task. Append-only.
CREATE TABLE skill_usage (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  skill_id          uuid NOT NULL,
  version           integer NOT NULL CHECK (version > 0),
  task_id           uuid,
  session_id        uuid,
  member_id         uuid NOT NULL,
  agent_identity_id uuid,
  adherence         text NOT NULL DEFAULT 'followed' CHECK (adherence IN ('followed', 'partial', 'consulted')),
  used_at           timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, skill_id, version) REFERENCES skill_versions (tenant_id, skill_id, version) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, member_id) REFERENCES members (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX skill_usage_skill_idx ON skill_usage (tenant_id, skill_id, used_at);
CREATE INDEX skill_usage_task_idx ON skill_usage (tenant_id, task_id) WHERE task_id IS NOT NULL;

-- Each measurement run's result per skill: used vs not used, same category and window.
CREATE TABLE skill_measurements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  skill_id     uuid NOT NULL,
  version      integer,
  window_days  integer NOT NULL,
  used_n       integer NOT NULL,
  used_success integer NOT NULL,
  base_n       integer NOT NULL,
  base_success integer NOT NULL,
  lift         double precision,
  ci_low       double precision,
  ci_high      double precision,
  status       text NOT NULL CHECK (status IN ('insufficient', 'no_effect', 'improves', 'degrades')),
  measured_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, skill_id) REFERENCES skills (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX skill_measurements_skill_idx ON skill_measurements (tenant_id, skill_id, measured_at DESC);

-- A served skill that measurably hurts outcomes goes back to its reviewers.
ALTER TABLE skills ADD COLUMN flagged_at timestamptz;
ALTER TABLE skills ADD COLUMN flag_reason text CHECK (length(flag_reason) <= 500);

-- Agents read approved skills with the skills:read scope, now on new keys by default. Keys that
-- can already read the team's history (more sensitive than approved skills) get it too.
ALTER TABLE agent_identities ALTER COLUMN scopes SET DEFAULT '{capture:write,history:read,skills:read,collab}';
UPDATE agent_identities SET scopes = array_append(scopes, 'skills:read')
 WHERE 'history:read' = ANY (scopes) AND NOT 'skills:read' = ANY (scopes);

-- Notifications ------------------------------------------------------------------------------------

-- An outbox: written in the same transaction as what it reports, sent by the worker.
-- Payloads hold ids and already-redacted text only.
CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  member_id  uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('channel_request', 'skill_review', 'skill_flagged',
                                           'skill_approved', 'skill_retired')),
  payload    jsonb NOT NULL DEFAULT '{}',
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  attempts   integer NOT NULL DEFAULT 0,
  last_error text CHECK (length(last_error) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz,
  FOREIGN KEY (tenant_id, member_id) REFERENCES members (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX notifications_pending_idx ON notifications (tenant_id, created_at) WHERE status = 'pending';

-- Row-level security and grants ------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['connection_secrets', 'hubspot_sequences', 'task_attributions',
                           'skill_subscriptions', 'skill_usage', 'skill_measurements', 'notifications']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I
                      USING (tenant_id = mm_current_tenant())
                      WITH CHECK (tenant_id = mm_current_tenant())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON connection_secrets, hubspot_sequences, notifications TO mm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON task_attributions TO mm_app;
GRANT SELECT, INSERT, DELETE ON skill_subscriptions TO mm_app;
-- Usage and measurements are append-only; erasure deletes a member's usage as admin.
GRANT SELECT, INSERT ON skill_usage, skill_measurements TO mm_app;

ALTER TABLE lake_outbox DROP CONSTRAINT lake_outbox_lake_table_check;
ALTER TABLE lake_outbox ADD CONSTRAINT lake_outbox_lake_table_check
  CHECK (lake_table IN ('actions', 'tasks', 'metric_observations', 'task_categories', 'judgments',
                        'channel_messages', 'skill_usage'));
