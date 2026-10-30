// Security properties of the infrastructure, checked on the synthesized CloudFormation.
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { AppStack } from "../lib/app-stack.ts";
import { STAGES } from "../lib/config.ts";
import { DataStack } from "../lib/data-stack.ts";
import { NetworkStack } from "../lib/network-stack.ts";

function synth(stage: "dev" | "prod") {
  const app = new App();
  const cfg = STAGES[stage];
  const network = new NetworkStack(app, "Net", cfg);
  const data = new DataStack(app, "Data", cfg, { vpc: network.vpc });
  return { network: Template.fromStack(network), data: Template.fromStack(data) };
}

describe.each(["dev", "prod"] as const)("%s", (stage) => {
  const { network, data } = synth(stage);

  it("Postgres is encrypted, private, SSL-only, backed up", () => {
    data.hasResourceProperties("AWS::RDS::DBInstance", {
      StorageEncrypted: true,
      PubliclyAccessible: false,
      BackupRetentionPeriod: STAGES[stage].dbBackupDays,
      EnableIAMDatabaseAuthentication: true,
      DeletionProtection: STAGES[stage].retainData,
    });
    data.hasResourceProperties("AWS::RDS::DBParameterGroup", {
      Parameters: Match.objectLike({ "rds.force_ssl": "1" }),
    });
  });

  it("the database security group allows no ingress by default and no egress", () => {
    const sgs = data.findResources("AWS::EC2::SecurityGroup", {
      Properties: { GroupDescription: Match.stringLikeRegexp("Postgres") },
    });
    const sg = Object.values(sgs)[0] as { Properties: Record<string, unknown> };
    expect(sg.Properties.SecurityGroupIngress).toBeUndefined();
    expect(JSON.stringify(sg.Properties.SecurityGroupEgress)).toContain("255.255.255.255/32");
  });

  it("the bronze bucket blocks public access, requires TLS, and expires data after 30 days", () => {
    data.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: "aws:kms" }),
          }),
        ],
      },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 30, Status: "Enabled" })]),
      },
    });
    data.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
        ]),
      }),
    });
  });

  it("KMS keys rotate", () => {
    data.hasResourceProperties("AWS::KMS::Key", { EnableKeyRotation: true });
  });

  it("the VPC has flow logs and private endpoints for Bedrock and Secrets Manager", () => {
    network.resourceCountIs("AWS::EC2::FlowLog", 1);
    const endpoints = JSON.stringify(network.findResources("AWS::EC2::VPCEndpoint"));
    expect(endpoints).toContain(".bedrock-runtime");
    expect(endpoints).toContain(".secretsmanager");
  });

  it("production data survives stack deletion", () => {
    const db = Object.values(data.findResources("AWS::RDS::DBInstance"))[0] as {
      DeletionPolicy: string;
    };
    expect(db.DeletionPolicy).toBe(stage === "prod" ? "Snapshot" : "Delete");
  });
});

describe("app stack (api, worker, web)", () => {
  // Asset staging off: the test checks wiring, not the Docker build.
  const app = new App({ context: { "aws:cdk:disable-asset-staging": true } });
  const cfg = STAGES.dev;
  const network = new NetworkStack(app, "Net", cfg);
  const data = new DataStack(app, "Data", cfg, { vpc: network.vpc });
  const stack = new AppStack(app, "App", cfg, {
    vpc: network.vpc,
    db: data.db,
    dbSecurityGroup: data.dbSecurityGroup,
    appDbSecret: data.appDbSecret,
    bronzeBucket: data.bronzeBucket,
  });
  const t = Template.fromStack(stack);

  const policyActionsFor = (rolePrefix: string): string[] => {
    const policies = t.findResources("AWS::IAM::Policy");
    return Object.entries(policies)
      .filter(([id]) => id.startsWith(rolePrefix))
      .flatMap(([, p]) =>
        (
          p as { Properties: { PolicyDocument: { Statement: { Action: string | string[] }[] } } }
        ).Properties.PolicyDocument.Statement.flatMap((st) => [st.Action].flat()),
      );
  };

  it("the API can write raw payloads but never read or delete them", () => {
    const actions = policyActionsFor("ApiTaskTaskRole");
    expect(actions).toEqual(expect.arrayContaining(["s3:PutObject"]));
    expect(actions.some((a) => /^s3:(Get|Delete)/.test(a))).toBe(false);
  });

  it("the worker can read and delete raw payloads and call Comprehend", () => {
    const actions = policyActionsFor("WorkerTaskTaskRole");
    expect(actions).toEqual(
      expect.arrayContaining(["s3:GetObject*", "s3:DeleteObject*", "comprehend:DetectPiiEntities"]),
    );
    expect(actions).not.toContain("s3:PutObject");
  });

  it("routes /mcp and /v1/* to the API on the shared load balancer", () => {
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::ListenerRule", {
      Conditions: [{ Field: "path-pattern", PathPatternConfig: { Values: ["/mcp", "/v1/*"] } }],
    });
  });

  it("web, api and worker each get their own Postgres ingress rule, nothing else", () => {
    const rules = Object.values(t.findResources("AWS::EC2::SecurityGroupIngress")).filter(
      (r) => (r as { Properties: { FromPort: number } }).Properties.FromPort === 5432,
    );
    expect(rules).toHaveLength(3);
  });

  it("the pseudonym secret is generated, not typed in", () => {
    t.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: "mastermind/dev/pseudonym",
      GenerateSecretString: Match.objectLike({ PasswordLength: 64 }),
    });
  });
});
