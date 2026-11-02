// Usage: pnpm --filter @mm/ops restore-drill
// Restores the production database to a new instance (latest restorable time), checks it
// (migrations, audit chains, row counts), writes a report, and deletes the instance.
// Runs as the ops task inside the VPC; see docs/runbook.md. Env:
//   MM_DB_INSTANCE_ID         source instance identifier
//   MM_DB_OWNER_SECRET_ARN    RDS master secret (the restored copy has the same credentials)
//   MM_DRILL_REPORT_BUCKET    optional: where the report is kept as evidence
import {
  DeleteDBInstanceCommand,
  DescribeDBInstancesCommand,
  RDSClient,
  RestoreDBInstanceToPointInTimeCommand,
} from "@aws-sdk/client-rds";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ownerDatabaseUrl } from "../env.ts";
import { checkRestoredDatabase, renderRestoreReport } from "../restore.ts";

const source = process.env.MM_DB_INSTANCE_ID;
if (!source) throw new Error("MM_DB_INSTANCE_ID is required.");
const region = process.env.AWS_REGION ?? "us-east-1";
const rds = new RDSClient({ region });
const target = `mm-restore-drill-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;

const [src] =
  (await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: source }))).DBInstances ??
  [];
if (!src) throw new Error(`No instance ${source}.`);
const restoreStarted = new Date().toISOString();
console.log(`- restoring ${source} to ${target}`);
await rds.send(
  new RestoreDBInstanceToPointInTimeCommand({
    SourceDBInstanceIdentifier: source,
    TargetDBInstanceIdentifier: target,
    UseLatestRestorableTime: true,
    DBInstanceClass: src.DBInstanceClass,
    DBSubnetGroupName: src.DBSubnetGroup?.DBSubnetGroupName,
    VpcSecurityGroupIds: src.VpcSecurityGroups?.map((g) => g.VpcSecurityGroupId!),
    DBParameterGroupName: src.DBParameterGroups?.[0]?.DBParameterGroupName,
    MultiAZ: false,
    PubliclyAccessible: false,
    DeletionProtection: false,
    Tags: [{ Key: "mm:purpose", Value: "restore-drill" }],
  }),
);

let host: string | undefined;
let restoredTo = src.LatestRestorableTime?.toISOString() ?? "latest";
for (let i = 0; i < 120 && !host; i++) {
  await new Promise((r) => setTimeout(r, 30_000));
  const [inst] =
    (await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: target })))
      .DBInstances ?? [];
  if (inst?.DBInstanceStatus === "available") {
    host = inst.Endpoint?.Address;
    restoredTo = inst.LatestRestorableTime?.toISOString() ?? restoredTo;
  }
}
if (!host) throw new Error(`${target} didn't become available within an hour.`);
const available = new Date().toISOString();
console.log(`- ${target} available at ${host}`);

let report: string;
let ok = false;
try {
  const url = await ownerDatabaseUrl({ ...process.env, MM_DB_HOST: host, DATABASE_ADMIN_URL: "" });
  const check = await checkRestoredDatabase(url);
  ok = check.ok;
  report = renderRestoreReport(check, { restoreStarted, available, restoredTo, instance: target });
} finally {
  console.log(`- deleting ${target}`);
  await rds.send(
    new DeleteDBInstanceCommand({
      DBInstanceIdentifier: target,
      SkipFinalSnapshot: true,
      DeleteAutomatedBackups: true,
    }),
  );
}
console.log(report);
const bucket = process.env.MM_DRILL_REPORT_BUCKET;
if (bucket) {
  await new S3Client({ region }).send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `restore-drills/${restoreStarted.slice(0, 10)}.md`,
      Body: report,
      ContentType: "text/markdown",
    }),
  );
}
if (!ok) process.exit(1);
