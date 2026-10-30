-- Week 3: the lake outbox, the hot history index, member erasure, and the history:read scope.

-- Tenants -------------------------------------------------------------------------

-- Set by the lake provisioning CLI once the tenant's namespace, tables and roles exist.
-- Until then lake rows wait in the outbox.
ALTER TABLE tenants ADD COLUMN lake_ready_at timestamptz;

-- Background jobs (outbox publisher, hot-index pruning, erasure) work tenant by tenant
-- inside a tenant context. This is how they learn which tenants exist. Ids only.
CREATE FUNCTION mm_list_tenants_for_jobs()
RETURNS TABLE (tenant_id uuid, lake_ready boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT id, lake_ready_at IS NOT NULL FROM tenants ORDER BY created_at $$;
REVOKE ALL ON FUNCTION mm_list_tenants_for_jobs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mm_list_tenants_for_jobs() TO mm_app;

-- Agent scopes --------------------------------------------------------------------

ALTER TABLE agent_identities DROP CONSTRAINT agent_identities_scopes_check;
ALTER TABLE agent_identities ADD CONSTRAINT agent_identities_scopes_check
  CHECK (scopes <@ ARRAY['capture:write', 'history:read', 'skills:read', 'collab']::text[]);
ALTER TABLE agent_identities ALTER COLUMN scopes SET DEFAULT '{capture:write,history:read}';

-- Hot history index -----------------------------------------------------------------

-- 'simple' keeps identifiers and placeholders intact (no stemming, no stop words).
-- The parser reads "src/billing/invoice.ts" as one token, so the text is indexed a second
-- time with path and identifier separators turned into spaces: "invoice" matches too.
CREATE FUNCTION mm_search_text(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN t || ' ' || regexp_replace(t, '[/._:#@=-]+', ' ', 'g');

ALTER TABLE tasks ADD COLUMN search tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple', mm_search_text(title_redacted || ' ' || summary_redacted))
  ) STORED;
CREATE INDEX tasks_search_idx ON tasks USING gin (search);

ALTER TABLE action_events ADD COLUMN source capture_source NOT NULL DEFAULT 'mcp';
ALTER TABLE action_events ADD COLUMN search tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', mm_search_text(summary_redacted))) STORED;
CREATE INDEX action_events_search_idx ON action_events USING gin (search);

-- Lake outbox -----------------------------------------------------------------------

-- Rows for the lake, written in the same transaction as the Postgres row they mirror.
-- The worker publishes them to Firehose and deletes them. Already redacted.
CREATE TABLE lake_outbox (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- Unpublished rows go with their member when the member is erased.
  member_id  uuid,
  lake_table text NOT NULL CHECK (lake_table IN ('actions', 'tasks', 'metric_observations')),
  event_id   uuid NOT NULL,
  row        jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, member_id) REFERENCES members (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX lake_outbox_tenant_idx ON lake_outbox (tenant_id, id);

-- Member erasure ----------------------------------------------------------------------

-- One request per erased member. Postgres rows are deleted when the request is made
-- (the member row cascades); the worker then removes raw payloads and lake rows.
CREATE TABLE erasure_requests (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- No foreign key: the member row is already gone.
  subject_member_id      uuid NOT NULL,
  requested_by_member_id uuid,
  status                 text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'first_pass_done', 'done', 'failed')),
  bronze_deleted_at      timestamptz,
  lake_first_pass_at     timestamptz,
  -- A second lake pass catches rows that were still buffered in Firehose.
  lake_second_pass_due   timestamptz,
  lake_second_pass_at    timestamptz,
  -- When old Iceberg snapshots holding the rows have expired and their files are removed.
  physically_erased_by   timestamptz,
  attempts               integer NOT NULL DEFAULT 0,
  last_error             text CHECK (length(last_error) <= 2000),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, requested_by_member_id) REFERENCES members (tenant_id, id)
    ON DELETE SET NULL (requested_by_member_id)
);
CREATE INDEX erasure_requests_open_idx ON erasure_requests (tenant_id, status)
  WHERE status IN ('pending', 'first_pass_done');

-- Row-level security -----------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lake_outbox', 'erasure_requests']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I
                      USING (tenant_id = mm_current_tenant())
                      WITH CHECK (tenant_id = mm_current_tenant())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, DELETE ON lake_outbox TO mm_app;
-- SELECT ... FOR UPDATE (how the publisher claims a batch) needs UPDATE on some column.
-- Granting it on created_at alone keeps the rows themselves unchangeable.
GRANT UPDATE (created_at) ON lake_outbox TO mm_app;
GRANT SELECT, INSERT, UPDATE ON erasure_requests TO mm_app;
