# ADR 0001: Tenant isolation with Postgres row-level security

**Status:** accepted (week 1)

## Decision

All tenants share one Postgres database. Isolation is enforced by the database itself, not by
application `WHERE` clauses:

- Every tenant table has `tenant_id`, RLS enabled and **forced**, and a `tenant_isolation`
  policy comparing against `mm_current_tenant()`. The one exception: `tenants` is not forced,
  so the owner-defined lookup functions can resolve a WorkOS org before a context exists.
- `mm_current_tenant()` reads a **transaction-local** setting (`set_config(..., true)`), set only
  by `withTenant()` in `@mm/db`. With no context it returns NULL, so queries match nothing (fail closed).
- The runtime role `mm_app` is not the owner, not superuser, and has no `BYPASSRLS`.
  Migrations run as a separate owner role.
- Child tables use **composite foreign keys** `(tenant_id, x_id)`, so a row can't reference
  another tenant's row even by a guessed id.
- The tenant id always comes from the verified WorkOS session (org → tenant), never from
  request input.

## Guardrails

`packages/db/test/tenant-isolation.test.ts` reads the live catalog. Adding a table without
RLS, a policy, a tenant key, or seed coverage in the test fails CI. ESLint blocks importing
`pg` outside `@mm/db`.

## Consequences

- Every data access needs a tenant transaction; cross-tenant work (ops, backfills) needs an
  explicit, audited control-plane path.
- One database is simple and cheap now. If a customer needs physical isolation later, a
  tenant can move to its own database without changing application code.
