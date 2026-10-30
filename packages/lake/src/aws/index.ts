export { athenaLake, LakeQueryError, type AthenaLakeOptions } from "./athena.ts";
export { firehoseSink, ROUTE_NAMESPACE_FIELD, ROUTE_TABLE_FIELD } from "./firehose.ts";
export {
  icebergMetadata,
  provisionTenantLake,
  tenantKeyPolicy,
  tenantRolePolicy,
  type LakeProvisionClients,
  type LakeProvisionConfig,
  type ProvisionResult,
} from "./provision.ts";
