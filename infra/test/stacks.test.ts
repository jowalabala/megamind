// Security properties of the infrastructure, checked on the synthesized CloudFormation.
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { AppStack } from "../lib/app-stack.ts";
import { STAGES } from "../lib/config.ts";
import { DataStack } from "../lib/data-stack.ts";
import { LakeStack } from "../lib/lake-stack.ts";
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
  const lake = new LakeStack(app, "Lake", cfg);
  const stack = new AppStack(app, "App", cfg, {
    vpc: network.vpc,
    db: data.db,
    dbSecurityGroup: data.dbSecurityGroup,
    appDbSecret: data.appDbSecret,
    bronzeBucket: data.bronzeBucket,
    lake: {
      streamName: lake.streamName,
      streamArn: lake.streamArn,
      tableBucketArn: lake.tableBucketArn,
      tenantRolePathArn: lake.tenantRolePathArn,
    },
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

  it("the worker publishes to the lake stream and reaches tenant data only via tenant roles", () => {
    const statements = Object.entries(t.findResources("AWS::IAM::Policy"))
      .filter(([id]) => id.startsWith("WorkerTaskTaskRole"))
      .flatMap(
        ([, p]) =>
          (
            p as {
              Properties: {
                PolicyDocument: { Statement: { Action: unknown; Resource: unknown }[] };
              };
            }
          ).Properties.PolicyDocument.Statement,
      );
    const assume = statements.find((st) => st.Action === "sts:AssumeRole")!;
    expect(JSON.stringify(assume.Resource)).toContain("role/mastermind/dev/lake/*");
    expect(statements.some((st) => st.Action === "firehose:PutRecordBatch")).toBe(true);
    const actions = statements.flatMap((st) => [st.Action].flat()) as string[];
    // (kms: actions are for the bronze bucket's key.)
    expect(actions.some((a) => /^(athena|glue|s3tables|lakeformation):/.test(a))).toBe(false);
    const api = policyActionsFor("ApiTaskTaskRole");
    expect(api.some((a) => /^(sts:AssumeRole|firehose:)/.test(a))).toBe(false);
  });

  it("routes /mcp, /v1/* and /webhooks/* to the API on the shared load balancer", () => {
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::ListenerRule", {
      Conditions: [
        { Field: "path-pattern", PathPatternConfig: { Values: ["/mcp", "/v1/*", "/webhooks/*"] } },
      ],
    });
  });

  it("each service gets only its part of the GitHub App credentials", () => {
    const defs = Object.values(t.findResources("AWS::ECS::TaskDefinition")) as {
      Properties: { ContainerDefinitions: { Name: string; Secrets?: { Name: string }[] }[] };
    }[];
    const secretsOf = (name: string) =>
      defs
        .flatMap((d) => d.Properties.ContainerDefinitions)
        .find((c) => c.Name === name)!
        .Secrets!.map((x) => x.Name)
        .filter((n) => n.startsWith("MM_GITHUB"))
        .sort();
    expect(secretsOf("web")).toEqual([
      "MM_GITHUB_APP_SLUG",
      "MM_GITHUB_CLIENT_ID",
      "MM_GITHUB_CLIENT_SECRET",
    ]);
    expect(secretsOf("api")).toEqual(["MM_GITHUB_WEBHOOK_SECRET"]);
    expect(secretsOf("worker")).toEqual(["MM_GITHUB_APP_ID", "MM_GITHUB_PRIVATE_KEY"]);
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

describe.each(["dev", "prod"] as const)("lake stack (%s)", (stage) => {
  const app = new App();
  const cfg = STAGES[stage];
  const t = Template.fromStack(new LakeStack(app, "Lake", cfg));

  it("the table bucket is KMS-encrypted and removes unreferenced files", () => {
    t.hasResourceProperties("AWS::S3Tables::TableBucket", {
      TableBucketName: `mastermind-${stage}-lake`,
      EncryptionConfiguration: Match.objectLike({ SSEAlgorithm: "aws:kms" }),
      UnreferencedFileRemoval: { Status: "Enabled", UnreferencedDays: 3, NoncurrentDays: 1 },
    });
  });

  it("the stream is encrypted and routes each record to its tenant namespace and table", () => {
    t.hasResourceProperties("AWS::KinesisFirehose::DeliveryStream", {
      DeliveryStreamType: "DirectPut",
      DeliveryStreamEncryptionConfigurationInput: Match.objectLike({
        KeyType: "CUSTOMER_MANAGED_CMK",
      }),
      IcebergDestinationConfiguration: Match.objectLike({
        AppendOnly: true,
        // CloudFormation spells this one with a lowercase s for Iceberg destinations.
        s3BackupMode: "FailedDataOnly",
        CatalogConfiguration: {
          CatalogArn: Match.objectLike({
            "Fn::Join": Match.arrayWith([
              Match.arrayWith([`:catalog/s3tablescatalog/mastermind-${stage}-lake`]),
            ]),
          }),
        },
        ProcessingConfiguration: Match.objectLike({
          Processors: [
            Match.objectLike({
              Type: "MetadataExtraction",
              Parameters: Match.arrayWith([
                Match.objectLike({
                  ParameterName: "MetadataExtractionQuery",
                  ParameterValue: Match.stringLikeRegexp("._mm_namespace.*._mm_table"),
                }),
              ]),
            }),
          ],
        }),
      }),
    });
  });

  it("results and error buckets are private, encrypted and short-lived", () => {
    const buckets = Object.values(t.findResources("AWS::S3::Bucket")) as {
      Properties: Record<
        string,
        { Rules?: { ExpirationInDays?: number }[] } & Record<string, unknown>
      >;
    }[];
    expect(buckets).toHaveLength(2);
    for (const b of buckets) {
      expect(JSON.stringify(b.Properties.BucketEncryption)).toContain("aws:kms");
      expect(b.Properties.PublicAccessBlockConfiguration).toMatchObject({
        BlockPublicAcls: true,
        RestrictPublicBuckets: true,
      });
      expect(b.Properties.LifecycleConfiguration!.Rules![0]!.ExpirationInDays).toBeLessThanOrEqual(
        30,
      );
    }
  });

  it("the tenant role boundary allows only tenant workgroups and tenant-tagged keys", () => {
    const [boundary] = Object.values(t.findResources("AWS::IAM::ManagedPolicy")) as {
      Properties: {
        PolicyDocument: {
          Statement: { Action: string | string[]; Resource: unknown; Condition?: unknown }[];
        };
      };
    }[];
    const st = boundary!.Properties.PolicyDocument.Statement;
    const actions = st.flatMap((x) => [x.Action].flat());
    expect(actions.some((a) => /^(iam|sts|s3tables|firehose):/.test(a))).toBe(false);
    const athena = st.find((x) => [x.Action].flat().includes("athena:StartQueryExecution"))!;
    expect(JSON.stringify(athena.Resource)).toContain(`workgroup/mm-${stage}-t-*`);
    const kms = st.find((x) => [x.Action].flat().includes("kms:Decrypt"))!;
    expect(kms.Condition).toEqual({
      StringEquals: {
        "aws:ResourceTag/mm:purpose": "lake-tenant",
        "aws:ResourceTag/mm:stage": stage,
      },
    });
  });

  it("creates the account-level catalog integration only where configured", () => {
    t.resourceCountIs("AWS::Glue::Catalog", cfg.lakeIntegration === "create" ? 1 : 0);
    t.resourceCountIs("AWS::LakeFormation::Resource", cfg.lakeIntegration === "create" ? 1 : 0);
  });
});
