-- Extensions, the runtime role, and the tenant-context helper.

CREATE EXTENSION IF NOT EXISTS vector;

-- Runtime role for api / worker / web / gateway.
-- It never owns tables and can never bypass row-level security.
-- LOGIN + password are set per environment (dev seed script, RDS bootstrap task),
-- not in migrations.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mm_app') THEN
    CREATE ROLE mm_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO mm_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- The tenant for the current transaction, or NULL when none is set.
-- Every RLS policy compares against this, so a missing context matches no rows (fail closed).
-- The setting is always written with set_config(..., is_local => true), so it ends with the transaction.
CREATE OR REPLACE FUNCTION mm_current_tenant() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;
