// Every per-tenant lake resource name derives from the tenant id, so nothing needs a lookup.
import { assertTenantId } from "@mm/db";

const hex = (tenantId: string) => {
  assertTenantId(tenantId);
  return tenantId.replace(/-/g, "").toLowerCase();
};

/** S3 Tables namespace (and Glue database) holding one tenant's tables. */
export const tenantNamespace = (tenantId: string) => `t_${hex(tenantId)}`;

/** IAM role the query service assumes for one tenant. 46 characters at most. */
export const tenantRoleName = (stage: string, tenantId: string) =>
  `mm-lake-${stage}-t-${hex(tenantId)}`;

export const TENANT_ROLE_PATH = (stage: string) => `/mastermind/${stage}/lake/`;

export const tenantRoleArn = (accountId: string, stage: string, tenantId: string) =>
  `arn:aws:iam::${accountId}:role${TENANT_ROLE_PATH(stage)}${tenantRoleName(stage, tenantId)}`;

/** Athena workgroup for one tenant. Results are encrypted with the tenant's key. */
export const tenantWorkgroup = (stage: string, tenantId: string) =>
  `mm-${stage}-t-${hex(tenantId)}`;

export const tenantKeyAlias = (stage: string, tenantId: string) =>
  `alias/mastermind/${stage}/lake/t-${hex(tenantId)}`;

/** Glue catalog id that Athena and Lake Formation use for an S3 table bucket. */
export const s3TablesCatalog = (tableBucketName: string) => `s3tablescatalog/${tableBucketName}`;
