import path from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, IgnoreMode, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as rds from "aws-cdk-lib/aws-rds";
import type * as s3 from "aws-cdk-lib/aws-s3";
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
        },
      },
    });
    web.targetGroup.configureHealthCheck({
      path: "/",
      healthyHttpCodes: "200-399",
      interval: Duration.seconds(30),
    });

    // API and worker: one image, two entrypoints. -------------------------------------

    // Keys per-tenant pseudonyms (packages/ingest/src/redaction.ts). Generated, never typed.
    const pseudonymSecret = new secretsmanager.Secret(this, "PseudonymSecret", {
      secretName: `mastermind/${cfg.stage}/pseudonym`,
      description: "Secret for per-tenant pseudonym keys",
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
      environment: sharedEnv,
      secrets: dbSecrets,
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
    // Same load balancer as the web app: /mcp and /v1/* go to the API.
    web.listener.addTargets("ApiTargets", {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/mcp", "/v1/*"])],
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [api],
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
      environment: { ...sharedEnv, MM_PII_COMPREHEND: "on", AWS_REGION: this.region },
      secrets: {
        ...dbSecrets,
        MM_PSEUDONYM_SECRET: ecs.Secret.fromSecretsManager(pseudonymSecret),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "worker",
        logRetention: logs.RetentionDays.ONE_YEAR,
      }),
    });
    // The worker reads raw payloads, and deletes them when a member has opted out.
    props.bronzeBucket.grantRead(workerTask.taskRole, BRONZE_PREFIX);
    props.bronzeBucket.grantDelete(workerTask.taskRole, BRONZE_PREFIX);
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

    // Only app tasks may reach Postgres. The rules live in this stack so the data stack
    // never depends on the app stack.
    const toPostgres: [string, ecs.FargateService][] = [
      ["Web", web.service],
      ["Api", api],
      ["Worker", worker],
    ];
    for (const [name, service] of toPostgres) {
      new ec2.CfnSecurityGroupIngress(this, `${name}ToPostgres`, {
        groupId: props.dbSecurityGroup.securityGroupId,
        sourceSecurityGroupId: service.connections.securityGroups[0]!.securityGroupId,
        ipProtocol: "tcp",
        fromPort: 5432,
        toPort: 5432,
        description: `${name.toLowerCase()} -> postgres`,
      });
    }
  }
}
