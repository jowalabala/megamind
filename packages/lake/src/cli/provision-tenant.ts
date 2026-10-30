// Usage: pnpm --filter @mm/lake provision-tenant <tenant-id>
// Creates (or repairs) the tenant's lake, then marks the tenant lake-ready so the worker
// starts publishing its rows. Needs operator AWS credentials with Lake Formation admin.
import { AthenaClient } from "@aws-sdk/client-athena";
import { IAMClient } from "@aws-sdk/client-iam";
import { KMSClient } from "@aws-sdk/client-kms";
import { LakeFormationClient } from "@aws-sdk/client-lakeformation";
import { S3TablesClient } from "@aws-sdk/client-s3tables";
import { assertTenantId } from "@mm/db";
import { markTenantLakeReady } from "@mm/db/admin";
import { provisionTenantLake } from "../aws/provision.ts";
import { lakeConfigFromEnv } from "./config.ts";

const tenantId = process.argv[2];
assertTenantId(tenantId);
const cfg = lakeConfigFromEnv();
const region = { region: cfg.region };

const result = await provisionTenantLake(
  cfg,
  {
    kms: new KMSClient(region),
    s3tables: new S3TablesClient(region),
    iam: new IAMClient(region),
    athena: new AthenaClient(region),
    lakeformation: new LakeFormationClient(region),
  },
  tenantId,
  (step) => console.log(`- ${step}`),
);
console.log(JSON.stringify(result, null, 2));

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (adminUrl) {
  if (!(await markTenantLakeReady(adminUrl, tenantId))) {
    throw new Error(`Tenant ${tenantId} not found in the database.`);
  }
  console.log("Tenant marked lake-ready; the worker will start publishing its rows.");
} else {
  console.log("Set DATABASE_ADMIN_URL to mark the tenant lake-ready, or run:");
  console.log(`  UPDATE tenants SET lake_ready_at = now() WHERE id = '${tenantId}';`);
}
