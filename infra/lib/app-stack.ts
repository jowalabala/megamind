import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CfnOutput,
  Duration,
  IgnoreMode,
  RemovalPolicy,
  SecretValue,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import type { StageConfig } from "./config.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface AppStackProps extends StackProps {
  vpc: ec2.IVpc;
  db: rds.DatabaseInstance;
  dbSecurityGroup: ec2.ISecurityGroup;
  appDbSecret: secretsmanager.ISecret;
  bronzeBucket: s3.IBucket;
  lake: {
    streamName: string;
    streamArn: string;
    tableBucketArn: string;
    /** Per-tenant query roles live under this path (created by the provisioning CLI). */
    tenantRolePathArn: string;
    resultsBucketName: string;
  };
  /** Object-locked bucket for restore drill reports and other audit evidence. */
  evidenceBucket: s3.IBucket;
}

/** Bronze object keys all start with this prefix (see packages/ingest/src/bronze.ts). */
const BRONZE_PREFIX = "raw/*";

export class AppStack extends Stack {
  constructor(scope: Construct, id: string, cfg: StageConfig, props: AppStackProps) {
    super(scope, id, props);

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // Filled in by hand once (WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_COOKIE_PASSWORD).
    const workosSecret = new secretsmanager.Secret(this, "WorkosSecret", {
      secretName: `mastermind/${cfg.stage}/workos`,
      description: "WorkOS credentials for the web app (set values manually)",
    });

    // GitHub App credentials, split so each service holds only its part (values set manually):
    // the web app runs the OAuth flows, the API checks webhook signatures, the worker calls GitHub.
    const githubOauth = new secretsmanager.Secret(this, "GithubOauthSecret", {
      secretName: `mastermind/${cfg.stage}/github-oauth`,
      description:
        "GitHub App slug, client id and client secret (keys APP_SLUG, CLIENT_ID, CLIENT_SECRET)",
    });
    const githubWebhook = new secretsmanager.Secret(this, "GithubWebhookSecret", {
      secretName: `mastermind/${cfg.stage}/github-webhook`,
      description: "GitHub App webhook secret (key WEBHOOK_SECRET)",
    });
    const githubAppKey = new secretsmanager.Secret(this, "GithubAppKeySecret", {
      secretName: `mastermind/${cfg.stage}/github-app-key`,
      description: "GitHub App id and private key (keys APP_ID, PRIVATE_KEY)",
    });

    // HubSpot and Slack app credentials. Created empty so a deploy works before the apps are
    // registered; the services treat empty values as "not configured". Fill in by hand.
    const empty = (keys: string[]) =>
      Object.fromEntries(keys.map((k) => [k, SecretValue.unsafePlainText("")]));
    const hubspotApp = new secretsmanager.Secret(this, "HubspotAppSecret", {
      secretName: `mastermind/${cfg.stage}/hubspot-app`,
      description: "HubSpot app client id and secret (keys CLIENT_ID, CLIENT_SECRET)",
      secretObjectValue: empty(["CLIENT_ID", "CLIENT_SECRET"]),
    });
    const slackApp = new secretsmanager.Secret(this, "SlackAppSecret", {
      secretName: `mastermind/${cfg.stage}/slack-app`,
      description: "Slack app client id, client secret and signing secret",
      secretObjectValue: empty(["CLIENT_ID", "CLIENT_SECRET", "SIGNING_SECRET"]),
    });

    // Seals OAuth tokens (HubSpot refresh tokens, Slack bot tokens) before they reach the
    // database; each value is bound to its tenant by the encryption context.
    const tokenKey = new kms.Key(this, "TokenVaultKey", {
      description: "Master Mind token vault (OAuth tokens for integrations)",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Keys per-tenant pseudonyms (packages/ingest/src/redaction.ts). Generated, never typed.
    const pseudonymSecret = new secretsmanager.Secret(this, "PseudonymSecret", {
      secretName: `mastermind/${cfg.stage}/pseudonym`,
      description: "Secret for per-tenant pseudonym keys",
      generateSecretString: { excludePunctuation: true, passwordLength: 64 },
    });

    const web = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "Web", {
      cluster,
      desiredCount: cfg.webDesiredCount,
      cpu: 512,
      memoryLimitMiB: 1024,
      publicLoadBalancer: true,
      taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      // TODO(before pilot): ACM certificate + HTTPS listener once the domain is chosen, and
      // NEXT_PUBLIC_WORKOS_REDIRECT_URI passed as a Docker build arg.
      taskImageOptions: {
        image: ecs.ContainerImage.fromAsset(REPO_ROOT, {
          file: "apps/web/Dockerfile",
          ignoreMode: IgnoreMode.DOCKER,
        }),
        containerPort: 3000,
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: "web",
          logRetention: logs.RetentionDays.ONE_YEAR,
        }),
        environment: {
          NODE_ENV: "production",
          DATABASE_HOST: props.db.dbInstanceEndpointAddress,
          DATABASE_PORT: props.db.dbInstanceEndpointPort,
          DATABASE_NAME: "mastermind",
          DATABASE_SSL: "require",
        },
        secrets: {
          DATABASE_USER: ecs.Secret.fromSecretsManager(props.appDbSecret, "username"),
          DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(props.appDbSecret, "password"),
          WORKOS_API_KEY: ecs.Secret.fromSecretsManager(workosSecret, "WORKOS_API_KEY"),
          WORKOS_CLIENT_ID: ecs.Secret.fromSecretsManager(workosSecret, "WORKOS_CLIENT_ID"),
          WORKOS_COOKIE_PASSWORD: ecs.Secret.fromSecretsManager(
            workosSecret,
            "WORKOS_COOKIE_PASSWORD",
          ),
          MM_GITHUB_APP_SLUG: ecs.Secret.fromSecretsManager(githubOauth, "APP_SLUG"),
          MM_GITHUB_CLIENT_ID: ecs.Secret.fromSecretsManager(githubOauth, "CLIENT_ID"),
          MM_GITHUB_CLIENT_SECRET: ecs.Secret.fromSecretsManager(githubOauth, "CLIENT_SECRET"),
          MM_HUBSPOT_CLIENT_ID: ecs.Secret.fromSecretsManager(hubspotApp, "CLIENT_ID"),
          MM_HUBSPOT_CLIENT_SECRET: ecs.Secret.fromSecretsManager(hubspotApp, "CLIENT_SECRET"),
          MM_SLACK_CLIENT_ID: ecs.Secret.fromSecretsManager(slackApp, "CLIENT_ID"),
          MM_SLACK_CLIENT_SECRET: ecs.Secret.fromSecretsManager(slackApp, "CLIENT_SECRET"),
          // CSV outcome uploads are redacted in the web app, like everything else at ingest.
          MM_PSEUDONYM_SECRET: ecs.Secret.fromSecretsManager(pseudonymSecret),
        },
      },
    });
    // TODO(before pilot): https:// once the HTTPS listener exists.
    const webUrl = `http://${web.loadBalancer.loadBalancerDnsName}`;
    const webContainer = web.taskDefinition.defaultContainer!;
    webContainer.addEnvironment("AWS_REGION", this.region);
    webContainer.addEnvironment("MM_VAULT_KMS_KEY_ID", tokenKey.keyArn);
    webContainer.addEnvironment(
      "MM_HUBSPOT_REDIRECT_URI",
      `${webUrl}/integrations/hubspot/callback`,
    );
    webContainer.addEnvironment("MM_SLACK_REDIRECT_URI", `${webUrl}/integrations/slack/callback`);
    // The web app only seals tokens at install time; it never opens them.
    tokenKey.grantEncrypt(web.taskDefinition.taskRole);
    web.targetGroup.configureHealthCheck({
      path: "/",
      healthyHttpCodes: "200-399",
      interval: Duration.seconds(30),
    });

    // API and worker: one image, two entrypoints. -------------------------------------

    // Signs the 5-minute tokens the API gives agents for the real-time gateway.
    const gatewaySecret = new secretsmanager.Secret(this, "GatewaySecret", {
      secretName: `mastermind/${cfg.stage}/gateway`,
      description: "Shared by the API and the gateway to sign WebSocket tokens",
      generateSecretString: { excludePunctuation: true, passwordLength: 64 },
    });

    const servicesImage = ecs.ContainerImage.fromAsset(REPO_ROOT, {
      file: "apps/api/Dockerfile",
      ignoreMode: IgnoreMode.DOCKER,
    });
    const sharedEnv = {
      NODE_ENV: "production",
      DATABASE_HOST: props.db.dbInstanceEndpointAddress,
      DATABASE_PORT: props.db.dbInstanceEndpointPort,
      DATABASE_NAME: "mastermind",
      DATABASE_SSL: "require",
      MM_BRONZE_BUCKET: props.bronzeBucket.bucketName,
    };
    const dbSecrets = {
      DATABASE_USER: ecs.Secret.fromSecretsManager(props.appDbSecret, "username"),
      DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(props.appDbSecret, "password"),
    };

    const apiTask = new ecs.FargateTaskDefinition(this, "ApiTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
    });
    apiTask.addContainer("api", {
      image: servicesImage,
      command: ["node", "--enable-source-maps", "api/main.js"],
      portMappings: [{ containerPort: 4000 }],
      environment: {
        ...sharedEnv,
        // TODO(before pilot): wss:// once the HTTPS listener exists (same as the web app).
        MM_GATEWAY_URL: `ws://${web.loadBalancer.loadBalancerDnsName}`,
        MM_WEB_URL: webUrl,
      },
      secrets: {
        ...dbSecrets,
        MM_GITHUB_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(githubWebhook, "WEBHOOK_SECRET"),
        MM_GATEWAY_SECRET: ecs.Secret.fromSecretsManager(gatewaySecret),
        // Channel text is redacted synchronously in the API (deterministic layers).
        MM_PSEUDONYM_SECRET: ecs.Secret.fromSecretsManager(pseudonymSecret),
        // Verifies Slack button clicks (channel approvals).
        MM_SLACK_SIGNING_SECRET: ecs.Secret.fromSecretsManager(slackApp, "SIGNING_SECRET"),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "api",
        logRetention: logs.RetentionDays.ONE_YEAR,
      }),
    });
    // The API only writes raw payloads; it can never read them back.
    props.bronzeBucket.grantPut(apiTask.taskRole, BRONZE_PREFIX);

    const api = new ecs.FargateService(this, "Api", {
      cluster,
      taskDefinition: apiTask,
      desiredCount: cfg.apiDesiredCount,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
    });
    // Same load balancer as the web app: /mcp, /v1/* and /webhooks/* go to the API.
    web.listener.addTargets("ApiTargets", {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/mcp", "/v1/*", "/webhooks/*"])],
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [api],
      healthCheck: { path: "/healthz", interval: Duration.seconds(30) },
      deregistrationDelay: Duration.seconds(30),
    });

    // Real-time gateway: WebSockets on /ws, same load balancer.
    const gatewayTask = new ecs.FargateTaskDefinition(this, "GatewayTask", {
      cpu: 256,
      memoryLimitMiB: 512,
    });
    gatewayTask.addContainer("gateway", {
      image: servicesImage,
      command: ["node", "--enable-source-maps", "gateway/main.js"],
      portMappings: [{ containerPort: 4200 }],
      environment: { ...sharedEnv, PORT: "4200", MM_WEB_URL: webUrl },
      secrets: {
        ...dbSecrets,
        MM_GATEWAY_SECRET: ecs.Secret.fromSecretsManager(gatewaySecret),
        MM_PSEUDONYM_SECRET: ecs.Secret.fromSecretsManager(pseudonymSecret),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "gateway",
        logRetention: logs.RetentionDays.ONE_YEAR,
      }),
    });
    const gateway = new ecs.FargateService(this, "Gateway", {
      cluster,
      taskDefinition: gatewayTask,
      desiredCount: cfg.gatewayDesiredCount,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
    });
    web.listener.addTargets("GatewayTargets", {
      priority: 9,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/ws"])],
      port: 4200,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [gateway],
      healthCheck: { path: "/healthz", interval: Duration.seconds(30) },
      deregistrationDelay: Duration.seconds(30),
    });

    const workerTask = new ecs.FargateTaskDefinition(this, "WorkerTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
    });
    workerTask.addContainer("worker", {
      image: servicesImage,
      command: ["node", "--enable-source-maps", "worker/main.js"],
      environment: {
        ...sharedEnv,
        MM_PII_COMPREHEND: "on",
        AWS_REGION: this.region,
        MM_STAGE: cfg.stage,
        MM_LAKE_FIREHOSE_STREAM: props.lake.streamName,
        MM_LAKE_TABLE_BUCKET_ARN: props.lake.tableBucketArn,
        MM_WEB_URL: webUrl,
        MM_VAULT_KMS_KEY_ID: tokenKey.keyArn,
        MM_HUBSPOT_REDIRECT_URI: `${webUrl}/integrations/hubspot/callback`,
      },
      secrets: {
        ...dbSecrets,
        MM_PSEUDONYM_SECRET: ecs.Secret.fromSecretsManager(pseudonymSecret),
        MM_GITHUB_APP_ID: ecs.Secret.fromSecretsManager(githubAppKey, "APP_ID"),
        MM_GITHUB_PRIVATE_KEY: ecs.Secret.fromSecretsManager(githubAppKey, "PRIVATE_KEY"),
        MM_HUBSPOT_CLIENT_ID: ecs.Secret.fromSecretsManager(hubspotApp, "CLIENT_ID"),
        MM_HUBSPOT_CLIENT_SECRET: ecs.Secret.fromSecretsManager(hubspotApp, "CLIENT_SECRET"),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "worker",
        logRetention: logs.RetentionDays.ONE_YEAR,
      }),
    });
    // The worker opens tokens to call HubSpot and Slack, and re-seals rotated ones.
    tokenKey.grantEncryptDecrypt(workerTask.taskRole);
    // The worker reads raw payloads, and deletes them when a member opts out or is erased.
    props.bronzeBucket.grantRead(workerTask.taskRole, BRONZE_PREFIX);
    props.bronzeBucket.grantDelete(workerTask.taskRole, BRONZE_PREFIX);
    // Lake: publish to the stream; query and erase only by assuming one tenant's role.
    workerTask.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["firehose:PutRecordBatch"],
        resources: [props.lake.streamArn],
      }),
    );
    workerTask.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [props.lake.tenantRolePathArn],
      }),
    );
    // The provisioning CLI puts this in each tenant role's trust policy.
    new CfnOutput(this, "LakeTrustedRoleArns", { value: workerTask.taskRole.roleArn });
    workerTask.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        // DetectPiiEntities has no resource-level permissions.
        actions: ["comprehend:DetectPiiEntities"],
        resources: ["*"],
      }),
    );
    const worker = new ecs.FargateService(this, "Worker", {
      cluster,
      taskDefinition: workerTask,
      desiredCount: cfg.workerDesiredCount,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
    });

    // Ops: one-off operator tasks (tenant purge, restore drill), run with `aws ecs run-task`
    // (docs/runbook.md). Never a service. Its role holds only what those two jobs need.
    const opsTask = new ecs.FargateTaskDefinition(this, "OpsTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
    });
    const dbOwnerSecret = props.db.secret!;
    opsTask.addContainer("ops", {
      image: servicesImage,
      // Overridden per run: ops/purge-tenant.js <tenant-id> or ops/restore-drill.js.
      command: ["node", "--enable-source-maps", "ops/restore-drill.js"],
      environment: {
        NODE_ENV: "production",
        AWS_REGION: this.region,
        MM_STAGE: cfg.stage,
        MM_DB_INSTANCE_ID: props.db.instanceIdentifier,
        MM_DB_HOST: props.db.dbInstanceEndpointAddress,
        MM_DB_OWNER_SECRET_ARN: dbOwnerSecret.secretArn,
        MM_BRONZE_BUCKET: props.bronzeBucket.bucketName,
        MM_LAKE_TABLE_BUCKET_ARN: props.lake.tableBucketArn,
        MM_LAKE_RESULTS_BUCKET: props.lake.resultsBucketName,
        MM_VAULT_KMS_KEY_ID: tokenKey.keyArn,
        MM_DRILL_REPORT_BUCKET: props.evidenceBucket.bucketName,
      },
      secrets: {
        WORKOS_API_KEY: ecs.Secret.fromSecretsManager(workosSecret, "WORKOS_API_KEY"),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "ops",
        logRetention: logs.RetentionDays.ONE_YEAR,
      }),
    });
    const ops = opsTask.taskRole;
    // Read the owner secret. Granted on the role only: a grant on the data stack's key policy
    // would make that stack depend on this one.
    ops.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
        resources: [dbOwnerSecret.secretArn],
      }),
    );
    if (dbOwnerSecret.encryptionKey) {
      ops.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ["kms:Decrypt"],
          resources: [dbOwnerSecret.encryptionKey.keyArn],
          conditions: {
            StringEquals: { "kms:ViaService": `secretsmanager.${this.region}.amazonaws.com` },
          },
        }),
      );
    }
    // Purge: open sealed tokens to revoke them; delete raw payloads, lake and query results.
    tokenKey.grantDecrypt(ops);
    props.bronzeBucket.grantRead(ops, BRONZE_PREFIX);
    props.bronzeBucket.grantDelete(ops, BRONZE_PREFIX);
    const results = s3.Bucket.fromBucketName(this, "LakeResults", props.lake.resultsBucketName);
    results.grantRead(ops, "tenant=*");
    results.grantDelete(ops, "tenant=*");
    const arn = (service: string, resource: string) =>
      `arn:aws:${service}:${this.region}:${this.account}:${resource}`;
    ops.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["s3tables:DeleteTable", "s3tables:DeleteNamespace"],
        resources: [props.lake.tableBucketArn, `${props.lake.tableBucketArn}/*`],
      }),
    );
    ops.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["athena:DeleteWorkGroup"],
        resources: [arn("athena", `workgroup/mm-${cfg.stage}-t-*`)],
      }),
    );
    ops.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["iam:DeleteRole", "iam:DeleteRolePolicy"],
        resources: [props.lake.tenantRolePathArn],
      }),
    );
    // Only tenant lake keys (tagged at provisioning) can be scheduled for deletion.
    ops.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["kms:DescribeKey", "kms:ScheduleKeyDeletion"],
        resources: [arn("kms", "key/*")],
        conditions: { StringEquals: { "aws:ResourceTag/mm:purpose": "lake-tenant" } },
      }),
    );
    ops.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["kms:DescribeKey", "kms:DeleteAlias"],
        resources: [arn("kms", `alias/mastermind/${cfg.stage}/lake/*`)],
      }),
    );
    ops.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["kms:DeleteAlias"],
        resources: [arn("kms", "key/*")],
        conditions: { StringEquals: { "aws:ResourceTag/mm:purpose": "lake-tenant" } },
      }),
    );
    // Restore drill: restore to a temporary instance named mm-restore-drill-*, then delete it.
    ops.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["rds:DescribeDBInstances"],
        resources: ["*"],
      }),
    );
    ops.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["rds:RestoreDBInstanceToPointInTime", "rds:AddTagsToResource"],
        resources: [
          props.db.instanceArn,
          arn("rds", "db:mm-restore-drill-*"),
          arn("rds", "subgrp:*"),
          arn("rds", "pg:*"),
          arn("rds", "og:*"),
        ],
      }),
    );
    ops.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["rds:DeleteDBInstance"],
        resources: [arn("rds", "db:mm-restore-drill-*")],
      }),
    );
    props.evidenceBucket.grantPut(ops, "restore-drills/*");
    const opsSg = new ec2.SecurityGroup(this, "OpsSg", {
      vpc: props.vpc,
      description: "One-off ops tasks (purge, restore drill)",
    });
    new CfnOutput(this, "OpsTaskDefinition", { value: opsTask.taskDefinitionArn });
    new CfnOutput(this, "OpsSecurityGroup", { value: opsSg.securityGroupId });
    new CfnOutput(this, "ClusterName", { value: cluster.clusterName });

    // Only app tasks may reach Postgres. The rules live in this stack so the data stack
    // never depends on the app stack.
    const toPostgres: [string, string][] = [
      ["Web", web.service.connections.securityGroups[0]!.securityGroupId],
      ["Api", api.connections.securityGroups[0]!.securityGroupId],
      ["Gateway", gateway.connections.securityGroups[0]!.securityGroupId],
      ["Worker", worker.connections.securityGroups[0]!.securityGroupId],
      ["Ops", opsSg.securityGroupId],
    ];
    for (const [name, sourceSecurityGroupId] of toPostgres) {
      new ec2.CfnSecurityGroupIngress(this, `${name}ToPostgres`, {
        groupId: props.dbSecurityGroup.securityGroupId,
        sourceSecurityGroupId,
        ipProtocol: "tcp",
        fromPort: 5432,
        toPort: 5432,
        description: `${name.toLowerCase()} -> postgres`,
      });
    }
  }
}
