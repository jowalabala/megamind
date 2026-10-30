// Operator-only operations that need the migration (owner) role, e.g. from onboarding CLIs.
// Never used by the running services, which only hold mm_app credentials.
import pg from "pg";
import { assertTenantId } from "./client.ts";

/** Marks a tenant's lake as provisioned, so the worker starts publishing its rows. */
export async function markTenantLakeReady(adminUrl: string, tenantId: string): Promise<boolean> {
  assertTenantId(tenantId);
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const res = await client.query(
      "UPDATE tenants SET lake_ready_at = coalesce(lake_ready_at, now()) WHERE id = $1",
      [tenantId],
    );
    return res.rowCount === 1;
  } finally {
    await client.end();
  }
}
