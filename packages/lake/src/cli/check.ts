// Usage: pnpm --filter @mm/lake check <tenant-id> [resource-substring]
// Prints the tenant's lake row counts and latest actions, through the same tenant-scoped
// Athena path the services use. Your role must be in MM_LAKE_TRUSTED_ROLE_ARNS.
import { assertTenantId } from "@mm/db";
import { athenaLake } from "../aws/athena.ts";
import { lakeConfigFromEnv } from "./config.ts";

const [tenantId, resource] = process.argv.slice(2);
assertTenantId(tenantId);
const cfg = lakeConfigFromEnv();
const lake = athenaLake(cfg);
console.log("Rows per table:", await lake.tableCounts(tenantId));
for (const a of await lake.recentActions(tenantId, { limit: 10, resource })) {
  console.log(`${a.event_time}  ${a.kind.padEnd(9)} ${a.summary}  ${a.resources.join(" ")}`);
}
