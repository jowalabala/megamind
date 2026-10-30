import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as kms from "aws-cdk-lib/aws-kms";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import type { StageConfig } from "./config.ts";

export interface DataStackProps extends StackProps {
  vpc: ec2.IVpc;
}

/**
 * Postgres and the bronze (raw capture) bucket. Per-tenant KMS keys are created at
 * runtime during tenant provisioning, not here; this platform key covers shared data.
 */
export class DataStack extends Stack {
  readonly platformKey: kms.Key;
  readonly db: rds.DatabaseInstance;
  readonly dbSecurityGroup: ec2.SecurityGroup;
  /** Credentials for the mm_app runtime role (set in Postgres by the bootstrap task). */
  readonly appDbSecret: secretsmanager.Secret;
  readonly bronzeBucket: s3.Bucket;

  constructor(scope: Construct, id: string, cfg: StageConfig, props: DataStackProps) {
    super(scope, id, props);
    const removalPolicy = cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.platformKey = new kms.Key(this, "PlatformKey", {
      alias: `alias/mastermind-${cfg.stage}-platform`,
      enableKeyRotation: true,
      removalPolicy,
    });

    this.dbSecurityGroup = new ec2.SecurityGroup(this, "DbSg", {
      vpc: props.vpc,
      description: "Postgres; ingress only from app security groups",
      allowAllOutbound: false,
    });

    const parameterGroup = new rds.ParameterGroup(this, "DbParams", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      parameters: {
        "rds.force_ssl": "1",
        log_connections: "1",
        log_disconnections: "1",
        // Log DDL so schema changes are in the audit trail.
        log_statement: "ddl",
      },
    });

    this.db = new rds.DatabaseInstance(this, "Postgres", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: new ec2.InstanceType(cfg.dbInstanceClass),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.dbSecurityGroup],
      publiclyAccessible: false,
      multiAz: cfg.dbMultiAz,
      databaseName: "mastermind",
      // The master user owns the schema and runs migrations; the app never uses it.
      credentials: rds.Credentials.fromGeneratedSecret("mm_owner", {
        encryptionKey: this.platformKey,
      }),
      storageEncrypted: true,
      storageEncryptionKey: this.platformKey,
      allocatedStorage: 50,
      maxAllocatedStorage: 500,
      backupRetention: Duration.days(cfg.dbBackupDays),
      deleteAutomatedBackups: false,
      deletionProtection: cfg.retainData,
      removalPolicy: cfg.retainData ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
      autoMinorVersionUpgrade: true,
      parameterGroup,
      cloudwatchLogsExports: ["postgresql"],
      enablePerformanceInsights: true,
      performanceInsightEncryptionKey: this.platformKey,
      iamAuthentication: true,
    });

    // Encrypted with the AWS-managed Secrets Manager key: a customer key here would need its
    // key policy to name the app stack's role, which creates a cross-stack cycle.
    this.appDbSecret = new secretsmanager.Secret(this, "AppDbSecret", {
      description: "mm_app runtime role credentials",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "mm_app" }),
        generateStringKey: "password",
        excludePunctuation: true,
        passwordLength: 40,
      },
    });

    // Raw captured payloads before redaction. Short-lived by design (30 days).
    this.bronzeBucket = new s3.Bucket(this, "Bronze", {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.platformKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [
        {
          id: "expire-raw-30d",
          expiration: Duration.days(30),
          noncurrentVersionExpiration: Duration.days(1),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      removalPolicy,
      autoDeleteObjects: !cfg.retainData,
    });
  }
}
