-- Week 10: admin-edited packs and CSV outcomes, the rest of the revenue pack (marketing emails
-- and deals), and tenant deletion.

-- Admin-edited packs --------------------------------------------------------------------------

-- A tenant's own version of a pack (in the MVP: the generic pack). Every save is a new
-- version and old ones are kept, because judgments name the ruleset version they used.
CREATE TABLE tenant_packs (
  tenant_id            uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  pack_id              text NOT NULL CHECK (pack_id ~ '^[a-z][a-z0-9_]{0,31}$'),
  version              integer NOT NULL CHECK (version > 0),
  yaml                 text NOT NULL CHECK (length(yaml) <= 200000),
  created_by_member_id uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, pack_id, version),
  FOREIGN KEY (tenant_id, created_by_member_id) REFERENCES members (tenant_id, id) ON DELETE SET NULL (created_by_member_id)
);

-- One CSV upload of outcomes. Rows themselves become metric_observations; this keeps the
-- summary (no row contents) so admins can see what an upload did.
CREATE TABLE outcome_imports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  member_id  uuid,
  rows       integer NOT NULL CHECK (rows >= 0),
  stored     integer NOT NULL CHECK (stored >= 0),
  -- [{ line, problem }], capped; problems never echo cell values.
  problems   jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES members (tenant_id, id) ON DELETE SET NULL (member_id)
);

-- Revenue pack: marketing emails and deals ------------------------------------------------------

-- One published marketing email -> one task. Counts only (sent, delivered, opens, clicks,
-- unsubscribes); no recipient data is requested.
CREATE TABLE hubspot_marketing_emails (
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  task_id          uuid NOT NULL,
  connection_id    uuid,
  email_id         text NOT NULL CHECK (email_id ~ '^[0-9]{1,30}$'),
  owner_user_id    bigint,
  published_at     timestamptz NOT NULL,
  counts           jsonb NOT NULL DEFAULT '{}',
  synced_at        timestamptz NOT NULL DEFAULT now(),
  metrics_final_at timestamptz,
  PRIMARY KEY (tenant_id, task_id),
  UNIQUE (tenant_id, connection_id, email_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id) ON DELETE SET NULL (connection_id)
);

-- One deal -> one task, credited to its owner. Stage and outcome only; no amount, company
-- or contact data is requested.
CREATE TABLE hubspot_deals (
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  task_id          uuid NOT NULL,
  connection_id    uuid,
  deal_id          text NOT NULL CHECK (deal_id ~ '^[0-9]{1,30}$'),
  owner_user_id    bigint,
  pipeline         text CHECK (length(pipeline) <= 100),
  stage            text CHECK (length(stage) <= 100),
  deal_type        text CHECK (length(deal_type) <= 100),
  created_at_hs    timestamptz NOT NULL,
  closed_at        timestamptz,
  is_closed        boolean NOT NULL DEFAULT false,
  is_won           boolean NOT NULL DEFAULT false,
  synced_at        timestamptz NOT NULL DEFAULT now(),
  metrics_final_at timestamptz,
  PRIMARY KEY (tenant_id, task_id),
  UNIQUE (tenant_id, connection_id, deal_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id) ON DELETE SET NULL (connection_id)
);

-- Tenant deletion -------------------------------------------------------------------------------

-- An admin schedules deletion; after a grace period an operator purges everything (Postgres,
-- raw payloads, the lake, the tenant's lake key). The row stays afterwards as the record that
-- the tenant was deleted: ids and dates only, nothing about its people or work.
CREATE TABLE tenant_deletions (
  tenant_id              uuid PRIMARY KEY,
  requested_by_member_id uuid NOT NULL,
  requested_at           timestamptz NOT NULL DEFAULT now(),
  purge_after            timestamptz NOT NULL,
  status                 text NOT NULL DEFAULT 'scheduled'
                         CHECK (status IN ('scheduled', 'cancelled', 'purging', 'purged')),
  -- Which purge steps finished, and when: { postgres, bronze, lake, lake_key, connectors, ... }.
  steps                  jsonb NOT NULL DEFAULT '{}',
  purged_at              timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- While deletion is scheduled the tenant is suspended: agent keys stop working, webhooks are
-- dropped and background jobs skip it. Admins can still sign in and cancel.
ALTER TABLE tenants ADD COLUMN suspended_at timestamptz;

-- Row-level security and grants ------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_packs', 'outcome_imports', 'hubspot_marketing_emails',
                           'hubspot_deals', 'tenant_deletions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I
                      USING (tenant_id = mm_current_tenant())
                      WITH CHECK (tenant_id = mm_current_tenant())', t);
  END LOOP;
END $$;

-- Pack versions are append-only.
GRANT SELECT, INSERT ON tenant_packs, outcome_imports TO mm_app;
GRANT SELECT, INSERT, UPDATE ON hubspot_marketing_emails, hubspot_deals TO mm_app;
-- The app only reads deletion state; scheduling and cancelling go through the functions below.
GRANT SELECT ON tenant_deletions TO mm_app;

-- Schedules deletion of the current tenant and suspends it. The caller checks the requester
-- is an admin and writes the audit event in the same transaction.
CREATE FUNCTION mm_schedule_tenant_deletion(p_requested_by uuid, p_purge_after timestamptz)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_tenant uuid := mm_current_tenant();
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM members WHERE tenant_id = v_tenant AND id = p_requested_by AND role = 'admin') THEN
    RAISE EXCEPTION 'only an admin of this tenant can schedule its deletion' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_purge_after < now() + interval '1 day' THEN
    RAISE EXCEPTION 'the grace period must be at least one day' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO tenant_deletions (tenant_id, requested_by_member_id, purge_after)
  VALUES (v_tenant, p_requested_by, p_purge_after)
  ON CONFLICT (tenant_id) DO UPDATE
    SET requested_by_member_id = EXCLUDED.requested_by_member_id,
        requested_at = now(), purge_after = EXCLUDED.purge_after,
        status = 'scheduled', steps = '{}', updated_at = now()
    WHERE tenant_deletions.status = 'cancelled';
  UPDATE tenants SET suspended_at = coalesce(suspended_at, now()) WHERE id = v_tenant;
END
$$;
REVOKE ALL ON FUNCTION mm_schedule_tenant_deletion(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mm_schedule_tenant_deletion(uuid, timestamptz) TO mm_app;

-- Cancels a scheduled deletion of the current tenant, if the purge hasn't started.
CREATE FUNCTION mm_cancel_tenant_deletion() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_tenant uuid := mm_current_tenant();
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE tenant_deletions SET status = 'cancelled', updated_at = now()
   WHERE tenant_id = v_tenant AND status = 'scheduled';
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE tenants SET suspended_at = NULL WHERE id = v_tenant;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION mm_cancel_tenant_deletion() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mm_cancel_tenant_deletion() TO mm_app;

-- Suspended tenants: no agent keys, no webhooks, no background jobs.
CREATE OR REPLACE FUNCTION mm_authenticate_agent(p_key_hash text)
RETURNS TABLE (tenant_id uuid, agent_id uuid, member_id uuid, scopes text[], capture_opt_out boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant uuid;
  v_agent uuid;
BEGIN
  SELECT k.tenant_id, k.agent_identity_id INTO v_tenant, v_agent
    FROM agent_keys k
    JOIN tenants t ON t.id = k.tenant_id AND t.suspended_at IS NULL
   WHERE k.key_hash = p_key_hash;
  IF v_tenant IS NULL THEN
    RETURN;
  END IF;
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
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

CREATE OR REPLACE FUNCTION mm_list_tenants_for_jobs()
RETURNS TABLE (tenant_id uuid, lake_ready boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id, lake_ready_at IS NOT NULL FROM tenants WHERE suspended_at IS NULL ORDER BY created_at
$$;

CREATE OR REPLACE FUNCTION mm_resolve_connection(p_provider text, p_external_id text)
RETURNS TABLE (tenant_id uuid, connection_id uuid, status text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.tenant_id, c.id, c.status FROM connections c
    JOIN tenants t ON t.id = c.tenant_id AND t.suspended_at IS NULL
   WHERE c.provider = p_provider AND c.external_id = p_external_id
$$;

-- The audit log stays append-only for everyone, except while the owner role purges one whole
-- tenant (mm.purge_tenant set to that tenant, inside mm_purge_tenant). mm_app has no DELETE
-- privilege on audit_events, so it can't use this even by setting the variable.
CREATE OR REPLACE FUNCTION mm_audit_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.tenant_id::text = current_setting('mm.purge_tenant', true) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END
$$;

-- Deletes every row of one tenant from every table, except its tenant_deletions record.
-- Owner only (never granted to mm_app). Returns rows deleted per table.
CREATE FUNCTION mm_purge_tenant(p_tenant uuid) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
  v_table text;
  v_n bigint;
  v_out jsonb := '{}';
BEGIN
  SELECT status INTO v_status FROM tenant_deletions WHERE tenant_id = p_tenant FOR UPDATE;
  IF v_status IS NULL OR v_status NOT IN ('scheduled', 'purging') THEN
    RAISE EXCEPTION 'tenant % has no scheduled deletion', p_tenant USING ERRCODE = 'check_violation';
  END IF;
  -- Tables with forced RLS filter on the tenant context, even for the owner.
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  PERFORM set_config('mm.purge_tenant', p_tenant::text, true);

  DELETE FROM audit_events WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_out := v_out || jsonb_build_object('audit_events', v_n);
  DELETE FROM audit_chain_heads WHERE tenant_id = p_tenant;

  -- Everything else hangs off tenants with ON DELETE CASCADE; count before deleting.
  FOR v_table IN
    SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
       AND c.table_name NOT IN ('audit_events', 'audit_chain_heads', 'tenant_deletions')
     ORDER BY 1
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id = $1', v_table) INTO v_n USING p_tenant;
    IF v_n > 0 THEN
      v_out := v_out || jsonb_build_object(v_table, v_n);
    END IF;
  END LOOP;
  DELETE FROM tenants WHERE id = p_tenant;

  -- Anything a cascade didn't reach (a table without a foreign key to tenants).
  FOR v_table IN
    SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
       AND c.table_name <> 'tenant_deletions'
  LOOP
    EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', v_table) USING p_tenant;
  END LOOP;

  -- Queued jobs for this tenant.
  IF to_regclass('pgboss.job') IS NOT NULL THEN
    EXECUTE 'DELETE FROM pgboss.job WHERE data->>''tenantId'' = $1' USING p_tenant::text;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_out := v_out || jsonb_build_object('queued_jobs', v_n);
  END IF;

  UPDATE tenant_deletions
     SET status = 'purging', updated_at = now(),
         steps = steps || jsonb_build_object('postgres', now())
   WHERE tenant_id = p_tenant;
  RETURN v_out;
END
$$;
REVOKE ALL ON FUNCTION mm_purge_tenant(uuid) FROM PUBLIC;
