-- Week 8: collaboration channels (human-approved), leases, agreements; skill review.

-- Workspace rules for channels. One row per tenant; absent means the defaults.
CREATE TABLE collab_settings (
  tenant_id          uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  -- The kill switch: off closes every open channel and blocks new ones.
  enabled            boolean NOT NULL DEFAULT true,
  cross_team_allowed boolean NOT NULL DEFAULT false,
  max_ttl_minutes    integer NOT NULL DEFAULT 480 CHECK (max_ttl_minutes BETWEEN 5 AND 480),
  allowed_share      text[] NOT NULL DEFAULT '{intents,summaries,messages}'
                       CHECK (allowed_share <@ ARRAY['intents', 'summaries', 'diffs_redacted', 'messages']::text[]),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- A member's standing yes for their own agents, e.g. "my team, intents only". Still a human
-- decision, made ahead of time.
CREATE TABLE collab_preapprovals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  member_id      uuid NOT NULL,
  same_team_only boolean NOT NULL DEFAULT true,
  repo           text CHECK (length(repo) <= 300),
  -- The most this rule allows to be shared.
  share          text[] NOT NULL DEFAULT '{intents}'
                   CHECK (share <@ ARRAY['intents', 'summaries', 'diffs_redacted', 'messages']::text[]),
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, member_id) REFERENCES members (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE channels (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  purpose_redacted   text NOT NULL CHECK (length(purpose_redacted) BETWEEN 1 AND 1000),
  -- { "resources": [...], "share": [...], "ttl_minutes": n }
  scope              jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'requested'
                       CHECK (status IN ('requested', 'open', 'closed', 'expired', 'rejected')),
  requested_by       uuid NOT NULL,
  last_seq           bigint NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  opened_at          timestamptz,
  closes_at          timestamptz,
  closed_at          timestamptz,
  close_reason       text CHECK (length(close_reason) <= 300),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES agent_sessions (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX channels_open_idx ON channels (tenant_id, status, closes_at);

CREATE TABLE channel_participants (
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  channel_id         uuid NOT NULL,
  session_id         uuid NOT NULL,
  member_id          uuid NOT NULL,
  approval           text NOT NULL DEFAULT 'pending' CHECK (approval IN ('pending', 'approved', 'declined')),
  approved_via       text CHECK (approved_via IN ('web', 'slack', 'preapproval')),
  decided_at         timestamptz,
  -- Delivery bookkeeping for the gateway.
  delivered_seq      bigint NOT NULL DEFAULT 0,
  delivered_status   text,
  PRIMARY KEY (tenant_id, channel_id, session_id),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES channels (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, session_id) REFERENCES agent_sessions (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, member_id) REFERENCES members (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX channel_participants_member_idx ON channel_participants (tenant_id, member_id, approval);

CREATE TABLE channel_messages (
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  channel_id    uuid NOT NULL,
  seq           bigint NOT NULL CHECK (seq > 0),
  id            uuid NOT NULL,
  from_session  uuid NOT NULL,
  type          text NOT NULL CHECK (type IN ('intent_update', 'proposal', 'interface_change', 'question',
                                              'answer', 'handoff', 'claim', 'release', 'note')),
  body_redacted text NOT NULL CHECK (length(body_redacted) <= 8000),
  -- { "redactions": n, "injection": [...] }
  scan          jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel_id, seq),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES channels (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, from_session) REFERENCES agent_sessions (tenant_id, id) ON DELETE CASCADE
);

-- Fencing tokens only ever grow, across all leases: a stale holder can be told apart.
CREATE SEQUENCE lease_fencing_seq;
GRANT USAGE ON SEQUENCE lease_fencing_seq TO mm_app;

CREATE TABLE leases (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  resource       text NOT NULL CHECK (length(resource) <= 600),
  holder_session uuid NOT NULL,
  channel_id     uuid NOT NULL,
  fencing_token  bigint NOT NULL DEFAULT nextval('lease_fencing_seq'),
  expires_at     timestamptz NOT NULL,
  released_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, holder_session) REFERENCES agent_sessions (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, channel_id) REFERENCES channels (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX leases_resource_idx ON leases (tenant_id, resource) WHERE released_at IS NULL;

-- Who does what: versioned, with optimistic concurrency on the version number.
CREATE TABLE agreements (
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  channel_id    uuid NOT NULL,
  version       integer NOT NULL CHECK (version > 0),
  body_redacted text NOT NULL CHECK (length(body_redacted) BETWEEN 1 AND 8000),
  proposed_by   uuid NOT NULL,
  accepted_by   uuid[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel_id, version),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES channels (tenant_id, id) ON DELETE CASCADE
);

-- Skill review ---------------------------------------------------------------------------------

ALTER TABLE skills ADD COLUMN approved_version integer CHECK (approved_version > 0);

-- Members who may approve skills in a category, besides admins.
CREATE TABLE category_owners (
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  member_id  uuid NOT NULL,
  pack       text NOT NULL,
  category   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, member_id, pack, category),
  FOREIGN KEY (tenant_id, member_id) REFERENCES members (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE skill_reviews (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  skill_id   uuid NOT NULL,
  version    integer NOT NULL,
  action     text NOT NULL CHECK (action IN ('approve', 'reject', 'retire', 'rollback', 'restore')),
  member_id  uuid,
  note       text CHECK (length(note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, skill_id) REFERENCES skills (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, member_id) REFERENCES members (tenant_id, id) ON DELETE SET NULL (member_id)
);
CREATE INDEX skill_reviews_skill_idx ON skill_reviews (tenant_id, skill_id, created_at);

-- Library search over each version's text.
ALTER TABLE skill_versions ADD COLUMN search tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', mm_search_text(title || ' ' || body::text))) STORED;
CREATE INDEX skill_versions_search_idx ON skill_versions USING gin (search);

-- Row-level security and grants ------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['collab_settings', 'collab_preapprovals', 'channels', 'channel_participants',
                           'channel_messages', 'leases', 'agreements', 'category_owners', 'skill_reviews']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I
                      USING (tenant_id = mm_current_tenant())
                      WITH CHECK (tenant_id = mm_current_tenant())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON collab_settings, channels, channel_participants, leases, agreements TO mm_app;
GRANT SELECT, INSERT, DELETE ON collab_preapprovals, category_owners TO mm_app;
-- Transcripts and review history are append-only.
GRANT SELECT, INSERT ON channel_messages, skill_reviews TO mm_app;

ALTER TABLE lake_outbox DROP CONSTRAINT lake_outbox_lake_table_check;
ALTER TABLE lake_outbox ADD CONSTRAINT lake_outbox_lake_table_check
  CHECK (lake_table IN ('actions', 'tasks', 'metric_observations', 'task_categories', 'judgments',
                        'channel_messages'));
