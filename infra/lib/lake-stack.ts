import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as glue from "aws-cdk-lib/aws-glue";
import * as iam from "aws-cdk-lib/aws-iam";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lakeformation from "aws-cdk-lib/aws-lakeformation";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3tables from "aws-cdk-lib/aws-s3tables";
import type { Construct } from "constructs";
import type { StageConfig } from "./config.ts";

/**
 * The Iceberg lake: an S3 table bucket, its link into the Glue catalog and Lake Formation,
 * the Firehose stream the worker publishes to, and the Athena results bucket.
 *
 * Per-tenant pieces (namespace, tables, KMS key, query role, workgroup, grants) are made by
 * `pnpm --filter @mm/lake provision-tenant`, run by an operator: services never hold the
 * IAM/KMS admin rights that needs. Tenant roles must sit under the path below and carry the
 * permissions boundary defined here.
 */
export class LakeStack extends Stack {
  readonly tableBucketArn: string;
  readonly tableBucketName: string;
  readonly streamName: string;
  readonly streamArn: string;
  readonly tenantRolePathArn: string;
  readonly resultsBucketName: string;

  constructor(scope: Construct, id: string, cfg: StageConfig, props: StackProps = {}) {
    super(scope, id, props);
    const removalPolicy = cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const { account, region } = this;
    const tenantKeyCondition = {
      StringEquals: {
        "aws:ResourceTag/mm:purpose": "lake-tenant",
        "aws:ResourceTag/mm:stage": cfg.stage,
      },
    };

    // Shared lake key: the stream, the bucket default and the results/error buckets.
    // Tenant tables use their own keys (created per tenant).
    const key = new kms.Key(this, "LakeKey", {
      alias: `alias/mastermind-${cfg.stage}-lake`,
      enableKeyRotation: true,
      removalPolicy,
    });
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "S3TablesMaintenance",
        principals: [new iam.ServicePrincipal("maintenance.s3tables.amazonaws.com")],
        actions: ["kms:GenerateDataKey", "kms:Decrypt"],
        resources: ["*"],
      }),
    );

    this.tableBucketName = `mastermind-${cfg.stage}-lake`;
    const bucket = new s3tables.CfnTableBucket(this, "TableBucket", {
      tableBucketName: this.tableBucketName,
      encryptionConfiguration: { sseAlgorithm: "aws:kms", kmsKeyArn: key.keyArn },
      // After snapshots expire (7 days, set per table), unreferenced files are marked after 3
      // days and deleted 1 day later. This bounds how long erased rows exist physically.
      unreferencedFileRemoval: { status: "Enabled", unreferencedDays: 3, noncurrentDays: 1 },
    });
    bucket.applyRemovalPolicy(removalPolicy);
    this.tableBucketArn = bucket.attrTableBucketArn;
    const allTableBuckets = `arn:aws:s3tables:${region}:${account}:bucket/*`;
    const catalogArn = `arn:aws:glue:${region}:${account}:catalog/s3tablescatalog/${this.tableBucketName}`;
    const glueS3Tables = [
      `arn:aws:glue:${region}:${account}:catalog`,
      `arn:aws:glue:${region}:${account}:catalog/s3tablescatalog`,
      `arn:aws:glue:${region}:${account}:catalog/s3tablescatalog/*`,
      `arn:aws:glue:${region}:${account}:database/s3tablescatalog/${this.tableBucketName}/*`,
      `arn:aws:glue:${region}:${account}:table/s3tablescatalog/${this.tableBucketName}/*`,
    ];

    // Account-level link from S3 Tables to Glue + Lake Formation ("analytics integration").
    // It exists once per account and region: set lakeIntegration to "existing" if another
    // stack or the console already created it.
    let integration: glue.CfnCatalog | undefined;
    if (cfg.lakeIntegration === "create") {
      const lfRole = new iam.Role(this, "LakeFormationDataAccessRole", {
        assumedBy: new iam.ServicePrincipal("lakeformation.amazonaws.com"),
        description: "Lake Formation vends S3 Tables data access with this role",
      });
      lfRole.assumeRolePolicy!.addStatements(
        new iam.PolicyStatement({
          principals: [new iam.ServicePrincipal("lakeformation.amazonaws.com")],
          actions: ["sts:SetContext", "sts:SetSourceIdentity"],
          conditions: { StringEquals: { "aws:SourceAccount": account } },
        }),
      );
      lfRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["s3tables:*"],
          resources: [allTableBuckets, `${allTableBuckets}/table/*`],
        }),
      );
      key.grantEncryptDecrypt(lfRole);
      lfRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
          resources: [`arn:aws:kms:${region}:${account}:key/*`],
          conditions: tenantKeyCondition,
        }),
      );
      const registration = new lakeformation.CfnResource(this, "S3TablesRegistration", {
        resourceArn: allTableBuckets,
        roleArn: lfRole.roleArn,
        useServiceLinkedRole: false,
        withFederation: true,
      });
      integration = new glue.CfnCatalog(this, "S3TablesCatalog", {
        name: "s3tablescatalog",
        federatedCatalog: { identifier: allTableBuckets, connectionName: "aws:s3tables" },
        createDatabaseDefaultPermissions: [],
        createTableDefaultPermissions: [],
        allowFullTableExternalDataAccess: "True",
      });
      integration.node.addDependency(registration);
    }

    const encryptedBucket = (id: string, expireDays: number) =>
      new s3.Bucket(this, id, {
        encryption: s3.BucketEncryption.KMS,
        encryptionKey: key,
        bucketKeyEnabled: true,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        minimumTLSVersion: 1.2,
        objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
        lifecycleRules: [{ expiration: Duration.days(expireDays) }],
        removalPolicy,
        autoDeleteObjects: !cfg.retainData,
      });
    // Records Firehose could not write. Already redacted, but kept briefly anyway.
    const errors = encryptedBucket("FirehoseErrors", 30);
    // Athena results, under tenant=<id>/ and encrypted with the tenant's key by its workgroup.
    const results = encryptedBucket("AthenaResults", 7);
    this.resultsBucketName = results.bucketName;

    const firehoseRole = new iam.Role(this, "FirehoseRole", {
      assumedBy: new iam.ServicePrincipal("firehose.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": account } },
      }),
      description: "Firehose writes tenant Iceberg tables; Lake Formation grants it each namespace",
    });
    firehoseRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["glue:GetCatalog", "glue:GetDatabase", "glue:GetTable", "glue:UpdateTable"],
        resources: glueS3Tables,
      }),
    );
    firehoseRole.addToPolicy(
      new iam.PolicyStatement({ actions: ["lakeformation:GetDataAccess"], resources: ["*"] }),
    );
    firehoseRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
        resources: [`arn:aws:kms:${region}:${account}:key/*`],
        conditions: tenantKeyCondition,
      }),
    );
    errors.grantWrite(firehoseRole);
    key.grantEncryptDecrypt(firehoseRole);
    const logGroup = new logs.LogGroup(this, "FirehoseLogs", {
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy,
    });
    const logStream = new logs.LogStream(this, "FirehoseLogStream", { logGroup });
    logGroup.grantWrite(firehoseRole);

    this.streamName = `mastermind-${cfg.stage}-lake`;
    const stream = new firehose.CfnDeliveryStream(this, "LakeStream", {
      deliveryStreamName: this.streamName,
      deliveryStreamType: "DirectPut",
      deliveryStreamEncryptionConfigurationInput: {
        keyType: "CUSTOMER_MANAGED_CMK",
        keyArn: key.keyArn,
      },
      icebergDestinationConfiguration: {
        roleArn: firehoseRole.roleArn,
        catalogConfiguration: { catalogArn },
        appendOnly: true,
        // The 2-minute freshness target: publisher every 5 s + this buffer.
        bufferingHints: { intervalInSeconds: 60, sizeInMBs: 1 },
        retryOptions: { durationInSeconds: 300 },
        // Each record names its tenant namespace and table (packages/lake/src/aws/firehose.ts).
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: "MetadataExtraction",
              parameters: [
                {
                  parameterName: "MetadataExtractionQuery",
                  parameterValue:
                    '{destinationDatabaseName: ._mm_namespace, destinationTableName: ._mm_table, operation: "insert"}',
                },
                { parameterName: "JsonParsingEngine", parameterValue: "JQ-1.6" },
              ],
            },
          ],
        },
        s3BackupMode: "FailedDataOnly",
        s3Configuration: {
          bucketArn: errors.bucketArn,
          roleArn: firehoseRole.roleArn,
          errorOutputPrefix: "errors/!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/",
          encryptionConfiguration: { kmsEncryptionConfig: { awskmsKeyArn: key.keyArn } },
        },
        cloudWatchLoggingOptions: {
          enabled: true,
          logGroupName: logGroup.logGroupName,
          logStreamName: logStream.logStreamName,
        },
      },
    });
    stream.node.addDependency(firehoseRole);
    if (integration) stream.node.addDependency(integration);
    this.streamArn = stream.attrArn;

    // The most any per-tenant query role can ever do, whatever its own policy says.
    const boundary = new iam.ManagedPolicy(this, "TenantRoleBoundary", {
      managedPolicyName: `mastermind-${cfg.stage}-lake-tenant-boundary`,
      statements: [
        new iam.PolicyStatement({
          actions: [
            "athena:StartQueryExecution",
            "athena:GetQueryExecution",
            "athena:GetQueryResults",
            "athena:StopQueryExecution",
            "athena:GetWorkGroup",
          ],
          resources: [`arn:aws:athena:${region}:${account}:workgroup/mm-${cfg.stage}-t-*`],
        }),
        new iam.PolicyStatement({
          actions: [
            "s3:GetObject",
            "s3:PutObject",
            "s3:AbortMultipartUpload",
            "s3:ListBucket",
            "s3:GetBucketLocation",
          ],
          resources: [results.bucketArn, results.arnForObjects("tenant=*")],
        }),
        new iam.PolicyStatement({
          actions: [
            "glue:GetCatalog",
            "glue:GetDatabase",
            "glue:GetTable",
            "glue:GetTables",
            "glue:GetPartitions",
          ],
          resources: glueS3Tables,
        }),
        new iam.PolicyStatement({ actions: ["lakeformation:GetDataAccess"], resources: ["*"] }),
        new iam.PolicyStatement({
          actions: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
          resources: [`arn:aws:kms:${region}:${account}:key/*`],
          conditions: tenantKeyCondition,
        }),
      ],
    });
    this.tenantRolePathArn = `arn:aws:iam::${account}:role/mastermind/${cfg.stage}/lake/*`;

    // Inputs for the provisioning CLI (see README "Lake").
    new CfnOutput(this, "TableBucketArn", { value: this.tableBucketArn });
    new CfnOutput(this, "ResultsBucket", { value: results.bucketName });
    new CfnOutput(this, "FirehoseRoleArn", { value: firehoseRole.roleArn });
    new CfnOutput(this, "PermissionsBoundaryArn", { value: boundary.managedPolicyArn });
    new CfnOutput(this, "StreamName", { value: this.streamName });
  }
}
