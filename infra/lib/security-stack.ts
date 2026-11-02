import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudtrail from "aws-cdk-lib/aws-cloudtrail";
import * as config from "aws-cdk-lib/aws-config";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as guardduty from "aws-cdk-lib/aws-guardduty";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as securityhub from "aws-cdk-lib/aws-securityhub";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";
import type { StageConfig } from "./config.ts";

export interface SecurityStackProps extends StackProps {
  /** Raw captured payloads: every read and delete is logged (CloudTrail data events). */
  bronzeBucket: s3.IBucket;
  /** Where high-severity findings are emailed. */
  alertEmail?: string;
}

/**
 * Detection and evidence: CloudTrail (all regions, validated, encrypted), GuardDuty, Security
 * Hub with the AWS and CIS baselines, AWS Config (which Security Hub's checks need), alerts
 * for high-severity findings, and an object-locked bucket for audit evidence such as restore
 * drill reports.
 *
 * GuardDuty, Security Hub and Config exist once per account and region: with
 * securityServices "existing" this stack assumes another stage already enabled them.
 */
export class SecurityStack extends Stack {
  readonly evidenceBucket: s3.Bucket;
  readonly alerts: sns.Topic;

  constructor(scope: Construct, id: string, cfg: StageConfig, props: SecurityStackProps) {
    super(scope, id, props);
    const removalPolicy = cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    const logKey = new kms.Key(this, "SecurityLogKey", {
      description: `Master Mind ${cfg.stage} CloudTrail and evidence`,
      enableKeyRotation: true,
      removalPolicy,
    });

    const logBucket = new s3.Bucket(this, "TrailBucket", {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: logKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [
        {
          id: "keep-logs",
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(90) },
          ],
          expiration: Duration.days(cfg.retainData ? 730 : 90),
          noncurrentVersionExpiration: Duration.days(30),
        },
      ],
      removalPolicy,
      autoDeleteObjects: !cfg.retainData,
    });

    const trail = new cloudtrail.Trail(this, "Trail", {
      bucket: logBucket,
      encryptionKey: logKey,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      enableFileValidation: true,
      managementEvents: cloudtrail.ReadWriteType.ALL,
    });
    trail.addS3EventSelector([{ bucket: props.bronzeBucket, objectPrefix: "raw/" }], {
      readWriteType: cloudtrail.ReadWriteType.ALL,
      includeManagementEvents: false,
    });

    // Evidence that must not be altered: restore drill reports, purge records, exports.
    this.evidenceBucket = new s3.Bucket(this, "EvidenceBucket", {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: logKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      objectLockEnabled: true,
      objectLockDefaultRetention: cfg.retainData
        ? s3.ObjectLockRetention.compliance(Duration.days(400))
        : s3.ObjectLockRetention.governance(Duration.days(7)),
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.alerts = new sns.Topic(this, "SecurityAlerts", {
      displayName: `Master Mind ${cfg.stage} security alerts`,
      masterKey: logKey,
      enforceSSL: true,
    });
    logKey.grantEncryptDecrypt(new iam.ServicePrincipal("events.amazonaws.com"));
    if (props.alertEmail) {
      this.alerts.addSubscription(new subscriptions.EmailSubscription(props.alertEmail));
    }

    if (cfg.securityServices === "create") {
      new guardduty.CfnDetector(this, "GuardDuty", {
        enable: true,
        findingPublishingFrequency: "FIFTEEN_MINUTES",
        features: [
          { name: "S3_DATA_EVENTS", status: "ENABLED" },
          { name: "RDS_LOGIN_EVENTS", status: "ENABLED" },
          {
            name: "RUNTIME_MONITORING",
            status: "ENABLED",
            additionalConfiguration: [{ name: "ECS_FARGATE_AGENT_MANAGEMENT", status: "ENABLED" }],
          },
        ],
      });

      // Config records resource changes; Security Hub's controls read them.
      const configRole = new iam.CfnServiceLinkedRole(this, "ConfigRole", {
        awsServiceName: "config.amazonaws.com",
      });
      const recorder = new config.CfnConfigurationRecorder(this, "ConfigRecorder", {
        roleArn: `arn:aws:iam::${this.account}:role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig`,
        recordingGroup: { allSupported: true, includeGlobalResourceTypes: true },
      });
      recorder.node.addDependency(configRole);
      logBucket.addToResourcePolicy(
        new iam.PolicyStatement({
          principals: [new iam.ServicePrincipal("config.amazonaws.com")],
          actions: ["s3:GetBucketAcl", "s3:ListBucket"],
          resources: [logBucket.bucketArn],
        }),
      );
      logBucket.addToResourcePolicy(
        new iam.PolicyStatement({
          principals: [new iam.ServicePrincipal("config.amazonaws.com")],
          actions: ["s3:PutObject"],
          resources: [logBucket.arnForObjects(`config/AWSLogs/${this.account}/Config/*`)],
          conditions: { StringEquals: { "s3:x-amz-acl": "bucket-owner-full-control" } },
        }),
      );
      logKey.grantEncrypt(new iam.ServicePrincipal("config.amazonaws.com"));
      const delivery = new config.CfnDeliveryChannel(this, "ConfigDelivery", {
        s3BucketName: logBucket.bucketName,
        s3KeyPrefix: "config",
        s3KmsKeyArn: logKey.keyArn,
      });
      delivery.node.addDependency(recorder);

      const hub = new securityhub.CfnHub(this, "SecurityHub", {
        enableDefaultStandards: false,
        controlFindingGenerator: "SECURITY_CONTROL",
        autoEnableControls: true,
      });
      for (const [name, arn] of [
        [
          "Fsbp",
          `arn:aws:securityhub:${this.region}::standards/aws-foundational-security-best-practices/v/1.0.0`,
        ],
        [
          "Cis",
          `arn:aws:securityhub:${this.region}::standards/cis-aws-foundations-benchmark/v/3.0.0`,
        ],
      ] as const) {
        new securityhub.CfnStandard(this, `${name}Standard`, {
          standardsArn: arn,
        }).node.addDependency(hub);
      }
    }

    // High and critical findings, from either service, go to the alerts topic.
    new events.Rule(this, "HighFindings", {
      description: "GuardDuty findings of severity 7+ and critical Security Hub findings",
      eventPattern: {
        source: ["aws.guardduty", "aws.securityhub"],
        detailType: ["GuardDuty Finding", "Security Hub Findings - Imported"],
        detail: {
          $or: [
            { severity: [{ numeric: [">=", 7] }] },
            { findings: { Severity: { Label: ["CRITICAL", "HIGH"] } } },
          ],
        },
      },
      targets: [new targets.SnsTopic(this.alerts)],
    });

    new CfnOutput(this, "EvidenceBucketName", { value: this.evidenceBucket.bucketName });
    new CfnOutput(this, "TrailBucketName", { value: logBucket.bucketName });
  }
}
