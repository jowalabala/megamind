import path from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, IgnoreMode, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import type { StageConfig } from "./config.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface AppStackProps extends StackProps {
  vpc: ec2.IVpc;
  db: rds.DatabaseInstance;
  dbSecurityGroup: ec2.ISecurityGroup;
  appDbSecret: secretsmanager.ISecret;
}

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

    // Only app tasks may reach Postgres. The rule lives in this stack so the data stack
    // never depends on the app stack.
    new ec2.CfnSecurityGroupIngress(this, "WebToPostgres", {
      groupId: props.dbSecurityGroup.securityGroupId,
      sourceSecurityGroupId: web.service.connections.securityGroups[0]!.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      description: "web -> postgres",
    });
  }
}
