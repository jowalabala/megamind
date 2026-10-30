-- Week 6: live presence and skill drafts.

-- Live awareness is on by default for new agent keys.
ALTER TABLE agent_identities ALTER COLUMN scopes SET DEFAULT '{capture:write,history:read,collab}';

-- Presence = an active session that sent a heartbeat recently.
CREATE INDEX agent_sessions_live_idx ON agent_sessions (tenant_id, last_heartbeat_at)
  WHERE status = 'active';

-- A practice proposed from contrasting successful and unsuccessful work. Drafts only: review,
-- versions and deployment come later. Every step cites the tasks it was drawn from.
CREATE TABLE skill_drafts (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  pack            text NOT NULL,
  category        text NOT NULL,
  -- The training window the cohort was drawn from.
  window_from     timestamptz,
  window_to       timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'rejected')),
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  -- { when_to_use, preconditions[], steps[{ text, evidence[] }], anti_patterns[...], expected_outcome }
  body            jsonb NOT NULL,
  -- { success: [task ids], failure: [task ids], hints: [...] }
  cohort          jsonb NOT NULL,
  -- Citations that didn't point into the cohort and were removed.
  dropped_citations integer NOT NULL DEFAULT 0,
  low_confidence  boolean NOT NULL DEFAULT false,
  prompt_id       text NOT NULL,
  prompt_version  integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX skill_drafts_category_idx ON skill_drafts (tenant_id, pack, category, created_at);

ALTER TABLE skill_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON skill_drafts
  USING (tenant_id = mm_current_tenant())
  WITH CHECK (tenant_id = mm_current_tenant());
GRANT SELECT, INSERT, UPDATE ON skill_drafts TO mm_app;
