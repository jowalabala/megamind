// Usage: pnpm --filter @mm/backtest backtest <tenant-id> [--train-end YYYY-MM-DD] [--lake-dir DIR]
// Reads the lake (local files, or Athena when MM_LAKE_TABLE_BUCKET_ARN is set) and prints the
// v0 backtest report as Markdown. The default split is three months before today.
import { assertTenantId } from "@mm/db";
import { localLake, type LakeAdmin } from "@mm/lake";
import { athenaLake } from "@mm/lake/aws";
import { buildReport, renderMarkdown } from "../report.ts";

const args = process.argv.slice(2);
const tenantId = args[0];
assertTenantId(tenantId);
const flag = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const trainEnd = flag("--train-end")
  ? new Date(flag("--train-end")!)
  : new Date(Date.now() - 91 * 86_400_000);
if (Number.isNaN(trainEnd.getTime())) throw new Error("--train-end must be a date (YYYY-MM-DD)");

const bucketArn = process.env.MM_LAKE_TABLE_BUCKET_ARN;
const lake: Pick<LakeAdmin, "scan"> = bucketArn
  ? athenaLake({
      stage: process.env.MM_STAGE ?? "dev",
      region: process.env.AWS_REGION ?? "us-east-1",
      accountId: bucketArn.split(":")[4]!,
      tableBucketName: bucketArn.split("/").pop()!,
    })
  : localLake({ dir: flag("--lake-dir") ?? ".data/lake" });

process.stdout.write(renderMarkdown(await buildReport(lake, tenantId, { trainEnd })));
