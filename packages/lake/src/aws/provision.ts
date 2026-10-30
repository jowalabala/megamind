// Creates one tenant's lake: its KMS key, S3 Tables namespace and tables, Athena
// workgroup, query role and Lake Formation grants. Idempotent: run it again to repair or
// to add tables introduced later.
//
// Run by an operator (AWS SSO, Lake Formation admin) at tenant onboarding, not by the
// services: it needs IAM and KMS administration rights that no running service should hold.
import { CreateWorkGroupCommand, GetWorkGroupCommand } from "@aws-sdk/client-athena";
import { CreateRoleCommand, GetRoleCommand, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import {
  CreateAliasCommand,
  CreateKeyCommand,
  DescribeKeyCommand,
  EnableKeyRotationCommand,
} from "@aws-sdk/client-kms";
import { GrantPermissionsCommand, type Permission } from "@aws-sdk/client-lakeformation";
import {
  CreateNamespaceCommand,
  CreateTableCommand,
  PutTableMaintenanceConfigurationCommand,
} from "@aws-sdk/client-s3tables";
import {
  s3TablesCatalog,
  TENANT_ROLE_PATH,
  tenantKeyAlias,
  tenantNamespace,
  tenantRoleName,
  tenantWorkgroup,
} from "../naming.ts";
import { LAKE_TABLE_DEFS, LAKE_TABLES, type LakeTableDef } from "../tables.ts";

type Send = { send(command: unknown): Promise<unknown> };

export interface LakeProvisionConfig {
  stage: string;
  region: string;
  accountId: string;
  tableBucketArn: string;
  tableBucketName: string;
  /** Athena results bucket; each tenant writes under tenant=<id>/. */
  resultsBucket: string;
  firehoseRoleArn: string;
  /** Service task roles allowed to assume the tenant query role (API, worker). */
  trustedRoleArns: string[];
  /** Managed policy that caps what any tenant role can ever be granted. */
  permissionsBoundaryArn: string;
  /** Snapshots older than this are expired, which is when deleted rows are really gone. */
  snapshotRetentionHours?: number;
  bytesScannedCutoffPerQuery?: number;
}

export interface LakeProvisionClients {
  kms: Send;
  s3tables: Send;
  iam: Send;
  athena: Send;
  lakeformation: Send;
}

export interface ProvisionResult {
  namespace: string;
  keyArn: string;
  roleArn: string;
  workgroup: string;
  tables: string[];
}

const isName = (err: unknown, ...names: string[]) =>
  err instanceof Error && names.includes(err.name);

async function ignoring<T>(fn: () => Promise<T>, ...names: string[]): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (isName(err, ...names)) return undefined;
    throw err;
  }
}

/** New IAM roles take a few seconds to become usable by other services. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 6, delayMs = 2_000): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (
        i >= attempts ||
        !isName(err, "InvalidInputException", "ConcurrentModificationException")
      ) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
}

export function icebergMetadata(def: LakeTableDef) {
  const fields = def.columns.map((c, i) => ({
    id: i + 1,
    name: c.name,
    type: c.type,
    required: c.required ?? false,
  }));
  const idOf = (name: string) => {
    const f = fields.find((x) => x.name === name);
    if (!f) throw new Error(`Partition column ${name} missing from ${def.name}`);
    return f.id;
  };
  return {
    iceberg: {
      schema: { fields },
      partitionSpec: {
        specId: 0,
        fields: def.partitions.map((p, i) => ({
          sourceId: idOf(p.column),
          transform: p.transform,
          name: p.name,
          fieldId: 1000 + i,
        })),
      },
    },
  };
}

export function tenantKeyPolicy(cfg: LakeProvisionConfig) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        // IAM policies decide who may use the key (Firehose, Lake Formation, the tenant role).
        Sid: "AccountIamControl",
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${cfg.accountId}:root` },
        Action: "kms:*",
        Resource: "*",
      },
      {
        // S3 Tables compaction and snapshot expiry read and rewrite the encrypted files.
        Sid: "S3TablesMaintenance",
        Effect: "Allow",
        Principal: { Service: "maintenance.s3tables.amazonaws.com" },
        Action: ["kms:GenerateDataKey", "kms:Decrypt"],
        Resource: "*",
        Condition: {
          StringLike: { "kms:EncryptionContext:aws:s3:arn": `${cfg.tableBucketArn}/*` },
        },
      },
    ],
  };
}

export function tenantRolePolicy(cfg: LakeProvisionConfig, tenantId: string, keyArn: string) {
  const ns = tenantNamespace(tenantId);
  const catalog = s3TablesCatalog(cfg.tableBucketName);
  const glue = (path: string) => `arn:aws:glue:${cfg.region}:${cfg.accountId}:${path}`;
  const prefix = `tenant=${tenantId}/`;
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "OwnWorkgroup",
        Effect: "Allow",
        Action: [
          "athena:StartQueryExecution",
          "athena:GetQueryExecution",
          "athena:GetQueryResults",
          "athena:StopQueryExecution",
          "athena:GetWorkGroup",
        ],
        Resource: `arn:aws:athena:${cfg.region}:${cfg.accountId}:workgroup/${tenantWorkgroup(cfg.stage, tenantId)}`,
      },
      {
        Sid: "OwnResults",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"],
        Resource: `arn:aws:s3:::${cfg.resultsBucket}/${prefix}*`,
      },
      {
        Sid: "ListOwnResults",
        Effect: "Allow",
        Action: ["s3:ListBucket", "s3:GetBucketLocation"],
        Resource: `arn:aws:s3:::${cfg.resultsBucket}`,
        Condition: { StringLike: { "s3:prefix": [`${prefix}*`] } },
      },
      {
        Sid: "OwnCatalogEntries",
        Effect: "Allow",
        Action: [
          "glue:GetCatalog",
          "glue:GetDatabase",
          "glue:GetTable",
          "glue:GetTables",
          "glue:GetPartitions",
        ],
        Resource: [
          glue("catalog"),
          glue("catalog/s3tablescatalog"),
          glue(`catalog/${catalog}`),
          glue(`database/${catalog}/${ns}`),
          glue(`table/${catalog}/${ns}/*`),
        ],
      },
      {
        // Lake Formation vends data credentials only for what it granted (this namespace).
        Sid: "LakeFormationData",
        Effect: "Allow",
        Action: ["lakeformation:GetDataAccess"],
        Resource: "*",
      },
      {
        Sid: "OwnKey",
        Effect: "Allow",
        Action: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
        Resource: keyArn,
      },
    ],
  };
}

export async function provisionTenantLake(
  cfg: LakeProvisionConfig,
  clients: LakeProvisionClients,
  tenantId: string,
  log: (step: string) => void = () => {},
): Promise<ProvisionResult> {
  const ns = tenantNamespace(tenantId);
  const tags = { "mm:tenant": tenantId, "mm:stage": cfg.stage, "mm:purpose": "lake-tenant" };
  const tagList = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));

  // 1. Tenant KMS key. Deleting it later crypto-shreds the tenant's lake.
  const alias = tenantKeyAlias(cfg.stage, tenantId);
  let keyArn = (
    (await ignoring(
      () => clients.kms.send(new DescribeKeyCommand({ KeyId: alias })),
      "NotFoundException",
    )) as { KeyMetadata?: { Arn?: string } } | undefined
  )?.KeyMetadata?.Arn;
  if (!keyArn) {
    const created = (await clients.kms.send(
      new CreateKeyCommand({
        Description: `Master Mind ${cfg.stage} lake key for tenant ${tenantId}`,
        KeyUsage: "ENCRYPT_DECRYPT",
        Policy: JSON.stringify(tenantKeyPolicy(cfg)),
        Tags: Object.entries(tags).map(([TagKey, TagValue]) => ({ TagKey, TagValue })),
      }),
    )) as { KeyMetadata?: { Arn?: string; KeyId?: string } };
    keyArn = created.KeyMetadata?.Arn;
    if (!keyArn) throw new Error("CreateKey returned no ARN");
    await clients.kms.send(new EnableKeyRotationCommand({ KeyId: keyArn }));
    await clients.kms.send(new CreateAliasCommand({ AliasName: alias, TargetKeyId: keyArn }));
    log(`created KMS key ${alias}`);
  }

  // 2. Namespace and tables, each encrypted with the tenant key.
  await ignoring(
    () =>
      clients.s3tables.send(
        new CreateNamespaceCommand({ tableBucketARN: cfg.tableBucketArn, namespace: [ns] }),
      ),
    "ConflictException",
  );
  for (const table of LAKE_TABLES) {
    const created = await ignoring(
      () =>
        clients.s3tables.send(
          new CreateTableCommand({
            tableBucketARN: cfg.tableBucketArn,
            namespace: ns,
            name: table,
            format: "ICEBERG",
            metadata: icebergMetadata(LAKE_TABLE_DEFS[table]),
            encryptionConfiguration: { sseAlgorithm: "aws:kms", kmsKeyArn: keyArn },
            tags,
          }),
        ),
      "ConflictException",
    );
    if (created) log(`created table ${ns}.${table}`);
    await clients.s3tables.send(
      new PutTableMaintenanceConfigurationCommand({
        tableBucketARN: cfg.tableBucketArn,
        namespace: ns,
        name: table,
        type: "icebergSnapshotManagement",
        value: {
          status: "enabled",
          settings: {
            icebergSnapshotManagement: {
              minSnapshotsToKeep: 1,
              maxSnapshotAgeHours: cfg.snapshotRetentionHours ?? 168,
            },
          },
        },
      }),
    );
    await clients.s3tables.send(
      new PutTableMaintenanceConfigurationCommand({
        tableBucketARN: cfg.tableBucketArn,
        namespace: ns,
        name: table,
        type: "icebergCompaction",
        value: { status: "enabled", settings: { icebergCompaction: { strategy: "auto" } } },
      }),
    );
  }

  // 3. Query role: assumable only by the services, capped by the permissions boundary.
  const roleName = tenantRoleName(cfg.stage, tenantId);
  const path = TENANT_ROLE_PATH(cfg.stage);
  let roleArn = (
    (await ignoring(
      () => clients.iam.send(new GetRoleCommand({ RoleName: roleName })),
      "NoSuchEntityException",
    )) as { Role?: { Arn?: string } } | undefined
  )?.Role?.Arn;
  if (!roleArn) {
    const created = (await clients.iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
        Path: path,
        PermissionsBoundary: cfg.permissionsBoundaryArn,
        MaxSessionDuration: 3600,
        Description: `Master Mind lake queries for tenant ${tenantId}`,
        AssumeRolePolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { AWS: cfg.trustedRoleArns },
              Action: "sts:AssumeRole",
            },
          ],
        }),
        Tags: tagList,
      }),
    )) as { Role?: { Arn?: string } };
    roleArn = created.Role?.Arn;
    if (!roleArn) throw new Error("CreateRole returned no ARN");
    log(`created role ${roleName}`);
  }
  await clients.iam.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: "tenant-lake",
      PolicyDocument: JSON.stringify(tenantRolePolicy(cfg, tenantId, keyArn)),
    }),
  );

  // 4. Workgroup: results under the tenant's prefix, encrypted with the tenant key.
  const workgroup = tenantWorkgroup(cfg.stage, tenantId);
  const exists = await ignoring(
    () => clients.athena.send(new GetWorkGroupCommand({ WorkGroup: workgroup })),
    "InvalidRequestException",
    "ResourceNotFoundException",
  );
  if (!exists) {
    await clients.athena.send(
      new CreateWorkGroupCommand({
        Name: workgroup,
        Description: `Master Mind lake queries for tenant ${tenantId}`,
        Configuration: {
          EnforceWorkGroupConfiguration: true,
          PublishCloudWatchMetricsEnabled: true,
          BytesScannedCutoffPerQuery: cfg.bytesScannedCutoffPerQuery ?? 10 * 1024 ** 3,
          EngineVersion: { SelectedEngineVersion: "Athena engine version 3" },
          ResultConfiguration: {
            OutputLocation: `s3://${cfg.resultsBucket}/tenant=${tenantId}/`,
            EncryptionConfiguration: { EncryptionOption: "SSE_KMS", KmsKey: keyArn },
          },
        },
        Tags: tagList,
      }),
    );
    log(`created workgroup ${workgroup}`);
  }

  // 5. Lake Formation: Firehose writes the namespace, the tenant role reads and deletes it.
  const catalogId = `${cfg.accountId}:${s3TablesCatalog(cfg.tableBucketName)}`;
  const grant = (principal: string, database: Permission[], tables: Permission[]) =>
    withRetry(async () => {
      await clients.lakeformation.send(
        new GrantPermissionsCommand({
          Principal: { DataLakePrincipalIdentifier: principal },
          Resource: { Database: { CatalogId: catalogId, Name: ns } },
          Permissions: database,
        }),
      );
      await clients.lakeformation.send(
        new GrantPermissionsCommand({
          Principal: { DataLakePrincipalIdentifier: principal },
          Resource: { Table: { CatalogId: catalogId, DatabaseName: ns, TableWildcard: {} } },
          Permissions: tables,
        }),
      );
    });
  await grant(cfg.firehoseRoleArn, ["DESCRIBE"], ["ALL"]);
  await grant(roleArn, ["DESCRIBE"], ["SELECT", "DESCRIBE", "INSERT", "DELETE"]);
  log("granted Lake Formation permissions");

  return { namespace: ns, keyArn, roleArn, workgroup, tables: [...LAKE_TABLES] };
}
