-- Append-only, hash-chained audit log (one chain per tenant).
-- The hash is computed in @mm/audit; the database guarantees ordering and immutability.

CREATE TABLE audit_events (
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  seq         bigint NOT NULL CHECK (seq > 0),
  id          uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL,
  actor_type  text NOT NULL CHECK (actor_type IN ('member', 'agent', 'system')),
  actor_id    text,
  action      text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  target_type text,
  target_id   text,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash   text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash        text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id, seq)
);
CREATE INDEX audit_events_action_idx ON audit_events (tenant_id, action, occurred_at);

-- One row per tenant, locked FOR UPDATE while an event is appended. This keeps each
-- tenant's chain strictly linear under concurrent writers.
CREATE TABLE audit_chain_heads (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
  last_seq  bigint NOT NULL,
  last_hash text NOT NULL CHECK (last_hash ~ '^[0-9a-f]{64}$')
);

CREATE FUNCTION mm_audit_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION mm_audit_immutable();
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION mm_audit_immutable();

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_events
  USING (tenant_id = mm_current_tenant())
  WITH CHECK (tenant_id = mm_current_tenant());

ALTER TABLE audit_chain_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_chain_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_chain_heads
  USING (tenant_id = mm_current_tenant())
  WITH CHECK (tenant_id = mm_current_tenant());

-- No UPDATE or DELETE on events for the app, at all.
GRANT SELECT, INSERT ON audit_events TO mm_app;
GRANT SELECT, INSERT, UPDATE ON audit_chain_heads TO mm_app;
