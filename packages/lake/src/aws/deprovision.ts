// Removes one tenant's lake, for tenant deletion: tables, namespace, Athena workgroup, query
// role, Athena results, and finally the tenant's KMS key (scheduled for deletion, the AWS
// minimum of 7 days). Once the key is gone, any file S3 Tables hasn't yet cleaned up, and any
// old snapshot, can no longer be decrypted by anyone: the lake is crypto-shredded.
//
// Operator-run (same rights as provisioning). Idempotent: run it again to finish a partial run.
import { DeleteWorkGroupCommand } from "@aws-sdk/client-athena";
import { DeleteRoleCommand, DeleteRolePolicyCommand } from "@aws-sdk/client-iam";
import {
  DeleteAliasCommand,
  DescribeKeyCommand,
  ScheduleKeyDeletionCommand,
} from "@aws-sdk/client-kms";
import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { DeleteNamespaceCommand, DeleteTableCommand } from "@aws-sdk/client-s3tables";
import { tenantKeyAlias, tenantNamespace, tenantRoleName, tenantWorkgroup } from "../naming.ts";
import { LAKE_TABLES } from "../tables.ts";
import type { LakeProvisionConfig } from "./provision.ts";

type Send = { send(command: unknown): Promise<unknown> };

export interface LakeDeprovisionClients {
  kms: Send;
  s3tables: Send;
  iam: Send;
  athena: Send;
  s3: Send;
}

export interface DeprovisionResult {
  tables: number;
  resultObjects: number;
  /** When AWS will delete the key; null if there was no key. */
  keyDeletionDate: Date | null;
}

const gone = (err: unknown) =>
  err instanceof Error &&
  [
    "NotFoundException",
    "NoSuchEntityException",
    "ResourceNotFoundException",
    "InvalidRequestException",
  ].includes(err.name);

async function ignoringMissing<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (gone(err)) return undefined;
    throw err;
  }
}

export async function deprovisionTenantLake(
  cfg: Pick<LakeProvisionConfig, "stage" | "tableBucketArn" | "resultsBucket">,
  clients: LakeDeprovisionClients,
  tenantId: string,
  log: (step: string) => void = () => {},
  options: { keyPendingDays?: number } = {},
): Promise<DeprovisionResult> {
  const ns = tenantNamespace(tenantId);
  let tables = 0;
  for (const name of LAKE_TABLES) {
    const done = await ignoringMissing(() =>
      clients.s3tables.send(
        new DeleteTableCommand({ tableBucketARN: cfg.tableBucketArn, namespace: ns, name }),
      ),
    );
    if (done !== undefined) tables++;
  }
  await ignoringMissing(() =>
    clients.s3tables.send(
      new DeleteNamespaceCommand({ tableBucketARN: cfg.tableBucketArn, namespace: ns }),
    ),
  );
  log(`deleted ${tables} tables and namespace ${ns}`);

  await ignoringMissing(() =>
    clients.athena.send(
      new DeleteWorkGroupCommand({
        WorkGroup: tenantWorkgroup(cfg.stage, tenantId),
        RecursiveDeleteOption: true,
      }),
    ),
  );
  const role = tenantRoleName(cfg.stage, tenantId);
  await ignoringMissing(() =>
    clients.iam.send(new DeleteRolePolicyCommand({ RoleName: role, PolicyName: "tenant-lake" })),
  );
  await ignoringMissing(() => clients.iam.send(new DeleteRoleCommand({ RoleName: role })));
  log("deleted workgroup and query role");

  // Athena query results under the tenant's prefix.
  let resultObjects = 0;
  const prefix = `tenant=${tenantId}/`;
  for (let token: string | undefined, i = 0; i < 10_000; i++) {
    const page = (await clients.s3.send(
      new ListObjectsV2Command({
        Bucket: cfg.resultsBucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    )) as { Contents?: { Key?: string }[]; NextContinuationToken?: string };
    const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((o) => o.Key);
    if (keys.length) {
      await clients.s3.send(
        new DeleteObjectsCommand({
          Bucket: cfg.resultsBucket,
          Delete: { Objects: keys, Quiet: true },
        }),
      );
      resultObjects += keys.length;
    }
    token = page.NextContinuationToken;
    if (!token) break;
  }
  log(`deleted ${resultObjects} query result objects`);

  const alias = tenantKeyAlias(cfg.stage, tenantId);
  const key = (await ignoringMissing(() =>
    clients.kms.send(new DescribeKeyCommand({ KeyId: alias })),
  )) as { KeyMetadata?: { KeyId?: string; KeyState?: string; DeletionDate?: Date } } | undefined;
  let keyDeletionDate: Date | null = null;
  const keyId = key?.KeyMetadata?.KeyId;
  if (keyId) {
    if (key.KeyMetadata?.KeyState === "PendingDeletion") {
      keyDeletionDate = key.KeyMetadata.DeletionDate ?? null;
    } else {
      const scheduled = (await clients.kms.send(
        new ScheduleKeyDeletionCommand({
          KeyId: keyId,
          PendingWindowInDays: options.keyPendingDays ?? 7,
        }),
      )) as { DeletionDate?: Date };
      keyDeletionDate = scheduled.DeletionDate ?? null;
    }
    await ignoringMissing(() => clients.kms.send(new DeleteAliasCommand({ AliasName: alias })));
    log(`scheduled key deletion for ${keyDeletionDate?.toISOString() ?? "(unknown date)"}`);
  }
  return { tables, resultObjects, keyDeletionDate };
}
