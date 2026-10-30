import { Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import type { StageConfig } from "./config.ts";

export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, cfg: StageConfig, props?: StackProps) {
    super(scope, id, props);

    // public: load balancer only; private: app containers (egress via NAT);
    // isolated: database, no route to the internet at all.
    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: cfg.natGateways,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "app", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: "data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      gatewayEndpoints: { S3: { service: ec2.GatewayVpcEndpointAwsService.S3 } },
    });

    // Network audit trail (SOC 2 CC7): every accepted and rejected flow.
    this.vpc.addFlowLog("FlowLogs", {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, "FlowLogGroup", { retention: logs.RetentionDays.ONE_YEAR }),
      ),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    // Keeps Bedrock and Secrets Manager traffic on the AWS network instead of going out through NAT.
    this.vpc.addInterfaceEndpoint("BedrockRuntime", {
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    this.vpc.addInterfaceEndpoint("SecretsManager", {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
  }
}
