// Usage: pnpm --filter @mm/ops purge-tenant <tenant-id> [--now --yes]
// Purges a tenant whose admin scheduled deletion, once the grace period has passed (or at
// once with --now --yes, only on the admin's written request). Runs as the ops task in AWS,
// or locally against a development database and lake directory. See docs/runbook.md.
import { AthenaClient } from "@aws-sdk/client-athena";
import { IAMClient } from "@aws-sdk/client-iam";
import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { S3TablesClient } from "@aws-sdk/client-s3tables";
import { assertTenantId } from "@mm/db";
import { fileBronze, s3Bronze, type BronzeStore } from "@mm/ingest";
import { localLake } from "@mm/lake";
import { deprovisionTenantLake } from "@mm/lake/aws";
import { vaultFromEnv } from "@mm/vault";
import { connectorRevoker } from "../connectors.ts";
import { ownerDatabaseUrl } from "../env.ts";
import { purgeTenant } from "../purge.ts";

const args = process.argv.slice(2);
const tenantId = args.find((a) => !a.startsWith("--"));
assertTenantId(tenantId);
const force = args.includes("--now");
if (force && !args.includes("--yes")) {
  console.error("--now skips the grace period. Add --yes to confirm the admin asked for it.");
  process.exit(2);
}
const adminUrl = await ownerDatabaseUrl();
const region = { region: process.env.AWS_REGION ?? "us-east-1" };

const bronze: BronzeStore = process.env.MM_BRONZE_BUCKET
  ? s3Bronze({ bucket: process.env.MM_BRONZE_BUCKET, region: region.region })
  : fileBronze(process.env.MM_BRONZE_DIR ?? "../../.data/bronze");
const tableBucketArn = process.env.MM_LAKE_TABLE_BUCKET_ARN;
const dropLake = async (id: string) => {
  if (tableBucketArn) {
    const results = process.env.MM_LAKE_RESULTS_BUCKET;
    const stage = process.env.MM_STAGE;
    if (!results || !stage) throw new Error("MM_LAKE_RESULTS_BUCKET and MM_STAGE are required.");
    await deprovisionTenantLake(
      { stage, tableBucketArn, resultsBucket: results },
      {
        kms: new KMSClient(region),
        s3tables: new S3TablesClient(region),
        iam: new IAMClient(region),
        athena: new AthenaClient(region),
        s3: new S3Client(region),
      },
      id,
      (s) => console.log(`  - ${s}`),
    );
  } else {
    await localLake({ dir: process.env.MM_LAKE_DIR ?? "../../.data/lake" }).dropTenant(id);
  }
};
const vault = vaultFromEnv();
const workosKey = process.env.WORKOS_API_KEY;

const report = await purgeTenant(
  {
    adminUrl,
    bronze,
    dropLake,
    force,
    revokeConnectors: vault
      ? connectorRevoker({
          adminUrl,
          vault,
          hubspotApiUrl: process.env.MM_HUBSPOT_API_URL || undefined,
          log: (m) => console.log(`  ! ${m}`),
        })
      : undefined,
    deleteIdentityOrg: workosKey
      ? async (orgId) => {
          const res = await fetch(
            `https://api.workos.com/organizations/${encodeURIComponent(orgId)}`,
            { method: "DELETE", headers: { authorization: `Bearer ${workosKey}` } },
          );
          if (!res.ok && res.status !== 404) throw new Error(`WorkOS returned ${res.status}`);
        }
      : undefined,
    log: (s) => console.log(`- ${s}`),
  },
  tenantId,
);
console.log(JSON.stringify(report, null, 2));
