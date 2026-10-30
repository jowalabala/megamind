-- Week 7: intents and overlaps (live awareness), and skills with immutable versions.

-- What an agent session says it is working on. Redacted like any captured text.
CREATE TABLE intents (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  session_id           uuid NOT NULL,
  member_id            uuid NOT NULL,
  description_redacted text NOT NULL CHECK (length(description_redacted) BETWEEN 1 AND 2000),
  resources            text[] NOT NULL DEFAULT '{}' CHECK (cardinality(resources) <= 100),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'abandoned')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES agent_sessions (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, member_id) REFERENCES members (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX intents_session_idx ON intents (tenant_id, session_id, status);

-- Two live sessions touching the same thing. One row per pair, kind and resource, so an
-- overlap alerts each side once; a later, stronger overlap (same lines) is its own row.
CREATE TABLE session_overlaps (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- session_a < session_b, so each pair has one order.
  session_a     uuid NOT NULL,
  session_b     uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('same_lines', 'same_resource', 'related_work')),
  severity      text NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
  -- The shared resource (file, list, tag) without line ranges; for related_work, the repo.
  resource      text NOT NULL CHECK (length(resource) <= 600),
  -- { "a_lines": [[10, 20]], "b_lines": [[15, 30]], "similarity": 0.83 }
  detail        jsonb NOT NULL DEFAULT '{}',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  notified_a_at timestamptz,
  notified_b_at timestamptz,
  CHECK (session_a < session_b),
  UNIQUE (tenant_id, session_a, session_b, kind, resource),
  FOREIGN KEY (tenant_id, session_a) REFERENCES agent_sessions (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, session_b) REFERENCES agent_sessions (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX session_overlaps_a_idx ON session_overlaps (tenant_id, session_a);
CREATE INDEX session_overlaps_b_idx ON session_overlaps (tenant_id, session_b);

-- Skills: what reviewers approve and agents receive. Each change is a new immutable version.
CREATE TABLE skills (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  pack            text NOT NULL,
  category        text NOT NULL,
  -- Normalized words of the practice, for finding duplicates.
  practice_key    text NOT NULL,
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  status          text NOT NULL DEFAULT 'in_review' CHECK (status IN ('in_review', 'approved', 'retired')),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  -- A variant of another skill (same goal, different situation).
  variant_of      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_of) REFERENCES skills (tenant_id, id) ON DELETE SET NULL (variant_of)
);
CREATE INDEX skills_category_idx ON skills (tenant_id, pack, category);

CREATE TABLE skill_versions (
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  skill_id        uuid NOT NULL,
  version         integer NOT NULL CHECK (version > 0),
  title           text NOT NULL,
  -- Same shape as a draft body, after verification.
  body            jsonb NOT NULL,
  -- { "success": [task ids], "failure": [task ids] }: merged across drafts for later versions.
  evidence        jsonb NOT NULL,
  -- Gate results: rubric scores, verifier outcome, rescan findings.
  gate            jsonb NOT NULL,
  source_draft_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, skill_id, version),
  FOREIGN KEY (tenant_id, skill_id) REFERENCES skills (tenant_id, id) ON DELETE CASCADE
);

-- Drafts record what the gate decided.
ALTER TABLE skill_drafts DROP CONSTRAINT skill_drafts_status_check;
ALTER TABLE skill_drafts ADD CONSTRAINT skill_drafts_status_check
  CHECK (status IN ('draft', 'rejected', 'accepted'));
ALTER TABLE skill_drafts ADD COLUMN gate jsonb;
ALTER TABLE skill_drafts ADD COLUMN skill_id uuid;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['intents', 'session_overlaps', 'skills', 'skill_versions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I
                      USING (tenant_id = mm_current_tenant())
                      WITH CHECK (tenant_id = mm_current_tenant())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON intents, session_overlaps, skills TO mm_app;
-- Versions are append-only: the app can add one but never change or delete it.
GRANT SELECT, INSERT ON skill_versions TO mm_app;
