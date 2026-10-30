-- Tenants, teams, members.

CREATE TYPE member_role AS ENUM ('admin', 'category_owner', 'member');
CREATE TYPE visibility_pref AS ENUM ('name', 'team', 'anonymous');

CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  slug          text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  workos_org_id text UNIQUE,
  region        text NOT NULL DEFAULT 'us-east-1',
  kms_key_arn   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  -- Target for composite foreign keys, so child rows can't point across tenants.
  UNIQUE (tenant_id, id)
);

CREATE TABLE members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  workos_user_id  text NOT NULL,
  email           text NOT NULL,
  display_name    text,
  role            member_role NOT NULL DEFAULT 'member',
  capture_opt_out boolean NOT NULL DEFAULT false,
  credit_opt_in   boolean NOT NULL DEFAULT false,
  visibility_pref visibility_pref NOT NULL DEFAULT 'team',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workos_user_id),
  UNIQUE (tenant_id, id)
);

CREATE TABLE team_members (
  tenant_id  uuid NOT NULL,
  team_id    uuid NOT NULL,
  member_id  uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, member_id),
  FOREIGN KEY (tenant_id, team_id) REFERENCES teams (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, member_id) REFERENCES members (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX team_members_member_idx ON team_members (tenant_id, member_id);

-- Row-level security -----------------------------------------------------------

-- tenants: RLS is enabled but not FORCED, so the SECURITY DEFINER lookup functions below
-- (owned by the migration role) can resolve a WorkOS org to a tenant before any tenant
-- context exists. mm_app is never the owner, so RLS always applies to it.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = mm_current_tenant())
  WITH CHECK (id = mm_current_tenant());

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON teams
  USING (tenant_id = mm_current_tenant())
  WITH CHECK (tenant_id = mm_current_tenant());

ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON members
  USING (tenant_id = mm_current_tenant())
  WITH CHECK (tenant_id = mm_current_tenant());

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON team_members
  USING (tenant_id = mm_current_tenant())
  WITH CHECK (tenant_id = mm_current_tenant());

-- Grants (least privilege) ------------------------------------------------------

-- Tenants are created only through mm_provision_tenant(); only the name is editable.
GRANT SELECT ON tenants TO mm_app;
GRANT UPDATE (name) ON tenants TO mm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON teams, members, team_members TO mm_app;

-- Control-plane functions --------------------------------------------------------

-- Creates a tenant and its first admin in one step. It sets the tenant context for the
-- rest of the caller's transaction, so the caller can write related rows (e.g. the
-- audit event) atomically.
CREATE FUNCTION mm_provision_tenant(
  p_name text,
  p_slug text,
  p_workos_org_id text,
  p_admin_workos_user_id text,
  p_admin_email text,
  p_admin_display_name text
) RETURNS TABLE (tenant_id uuid, admin_member_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant uuid := gen_random_uuid();
  v_member uuid;
BEGIN
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  INSERT INTO tenants (id, name, slug, workos_org_id)
    VALUES (v_tenant, p_name, p_slug, p_workos_org_id);
  INSERT INTO members (tenant_id, workos_user_id, email, display_name, role)
    VALUES (v_tenant, p_admin_workos_user_id, p_admin_email, p_admin_display_name, 'admin')
    RETURNING id INTO v_member;
  RETURN QUERY SELECT v_tenant, v_member;
END
$$;
REVOKE ALL ON FUNCTION mm_provision_tenant(text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mm_provision_tenant(text, text, text, text, text, text) TO mm_app;

-- Maps a verified WorkOS organization id (from the session) to its tenant.
-- Returns only the id, never tenant data.
CREATE FUNCTION mm_resolve_tenant_by_workos_org(p_workos_org_id text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id FROM tenants WHERE workos_org_id = p_workos_org_id
$$;
REVOKE ALL ON FUNCTION mm_resolve_tenant_by_workos_org(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mm_resolve_tenant_by_workos_org(text) TO mm_app;
