// Tenant purge: the operator step after an admin scheduled deletion and the grace period
// passed. Order matters: tokens are revoked and the identity org removed while Postgres still
// knows them; Postgres goes last so the deletion record can track every step. Each finished
// step is recorded, so a run that stops halfway is safe to repeat.
import {
  markTenantDeletionStep,
  purgeTenantRows,
  readTenantDeletion,
  tenantRowCounts,
  type TenantDeletionState,
} from "@mm/db/admin";
import type { BronzeStore } from "@mm/ingest";

export const PURGE_STEPS = [
  "connectors",
  "identity",
  "bronze",
  "lake",
  "postgres",
  "verified",
] as const;
export type PurgeStep = (typeof PURGE_STEPS)[number];

export interface PurgeDeps {
  /** Owner (migration role) connection: the app role can't purge. */
  adminUrl: string;
  bronze: BronzeStore;
  /** Drops the tenant's lake (AWS: deprovisionTenantLake; local: dropTenant). */
  dropLake: (tenantId: string) => Promise<void>;
  /** Revokes the tenant's HubSpot and Slack tokens. Returns how many were revoked. */
  revokeConnectors?: (tenantId: string) => Promise<number>;
  /** Deletes the tenant's WorkOS organization. */
  deleteIdentityOrg?: (workosOrgId: string) => Promise<void>;
  /** Purge before the grace period ends (the admin asked for it in writing). */
  force?: boolean;
  now?: () => Date;
  log?: (step: string) => void;
}

export class PurgeNotAllowedError extends Error {
  override name = "PurgeNotAllowedError";
}

export interface PurgeReport {
  tenantId: string;
  steps: Partial<Record<PurgeStep, string>>;
  postgresRows: Record<string, number>;
  bronzeObjects: number;
  connectorsRevoked: number;
}

/** Raw payloads of every member of a tenant live under this prefix. */
export const tenantBronzePrefix = (tenantId: string) => `raw/tenant=${tenantId}/`;

export async function purgeTenant(deps: PurgeDeps, tenantId: string): Promise<PurgeReport> {
  const log = deps.log ?? (() => {});
  const now = deps.now?.() ?? new Date();
  const state = await readTenantDeletion(deps.adminUrl, tenantId);
  check(state, tenantId, now, deps.force ?? false);
  const done = (step: PurgeStep) => Boolean(state!.steps[step]);
  const mark = (step: PurgeStep, last = false) =>
    markTenantDeletionStep(deps.adminUrl, tenantId, step, last);
  const report: PurgeReport = {
    tenantId,
    steps: {},
    postgresRows: {},
    bronzeObjects: 0,
    connectorsRevoked: 0,
  };

  if (!done("connectors") && !done("postgres")) {
    report.connectorsRevoked = deps.revokeConnectors ? await deps.revokeConnectors(tenantId) : 0;
    await mark("connectors");
    log(`revoked ${report.connectorsRevoked} connector token(s)`);
  }
  if (!done("identity") && !done("postgres")) {
    if (state!.workosOrgId && deps.deleteIdentityOrg) {
      await deps.deleteIdentityOrg(state!.workosOrgId);
      log("deleted the sign-in organization");
    }
    await mark("identity");
  }
  if (!done("bronze")) {
    report.bronzeObjects = await deps.bronze.deletePrefix(tenantBronzePrefix(tenantId));
    await mark("bronze");
    log(`deleted ${report.bronzeObjects} raw payload(s)`);
  }
  if (!done("lake")) {
    await deps.dropLake(tenantId);
    await mark("lake");
    log("dropped the lake");
  }
  if (!done("postgres")) {
    report.postgresRows = await purgeTenantRows(deps.adminUrl, tenantId);
    log(`deleted ${Object.values(report.postgresRows).reduce((a, b) => a + b, 0)} database row(s)`);
  }

  // Verify before recording the purge as finished.
  const left = Object.entries(await tenantRowCounts(deps.adminUrl, tenantId)).filter(
    ([, n]) => n > 0,
  );
  if (left.length) {
    throw new Error(`Rows remain after purge: ${left.map(([t, n]) => `${t}=${n}`).join(", ")}`);
  }
  const raw = await deps.bronze.deletePrefix(tenantBronzePrefix(tenantId));
  if (raw > 0) throw new Error(`${raw} raw payload(s) appeared during the purge; run it again.`);
  await mark("verified", true);
  log("verified: nothing of the tenant remains in Postgres or raw storage");

  const final = await readTenantDeletion(deps.adminUrl, tenantId);
  report.steps = final?.steps ?? {};
  return report;
}

function check(
  state: TenantDeletionState | null,
  tenantId: string,
  now: Date,
  force: boolean,
): asserts state is TenantDeletionState {
  if (!state || state.status === "cancelled") {
    throw new PurgeNotAllowedError(`Tenant ${tenantId} has no scheduled deletion.`);
  }
  if (state.status === "purged") {
    throw new PurgeNotAllowedError(`Tenant ${tenantId} was already purged.`);
  }
  if (!force && state.status === "scheduled" && state.purgeAfter > now) {
    throw new PurgeNotAllowedError(
      `The grace period runs until ${state.purgeAfter.toISOString()}; the admin can still cancel. ` +
        "Use --now only with the admin's written request to skip it.",
    );
  }
}
