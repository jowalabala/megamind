// Operator CLI configuration, from the LakeStack outputs (see README "Lake").
import type { LakeProvisionConfig } from "../aws/provision.ts";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required (see the LakeStack outputs).`);
  return v;
}

export function lakeConfigFromEnv(): LakeProvisionConfig {
  const tableBucketArn = required("MM_LAKE_TABLE_BUCKET_ARN");
  return {
    stage: required("MM_STAGE"),
    region: process.env.AWS_REGION ?? "us-east-1",
    accountId: tableBucketArn.split(":")[4]!,
    tableBucketArn,
    tableBucketName: tableBucketArn.split("/").pop()!,
    resultsBucket: required("MM_LAKE_RESULTS_BUCKET"),
    firehoseRoleArn: required("MM_LAKE_FIREHOSE_ROLE_ARN"),
    trustedRoleArns: required("MM_LAKE_TRUSTED_ROLE_ARNS")
      .split(",")
      .map((s) => s.trim()),
    permissionsBoundaryArn: required("MM_LAKE_PERMISSIONS_BOUNDARY_ARN"),
  };
}
