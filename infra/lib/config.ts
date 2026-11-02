export type Stage = "dev" | "prod";

export interface StageConfig {
  stage: Stage;
  natGateways: number;
  dbInstanceClass: string;
  dbMultiAz: boolean;
  dbBackupDays: number;
  /** Production data is never destroyed with the stack. */
  retainData: boolean;
  webDesiredCount: number;
  apiDesiredCount: number;
  gatewayDesiredCount: number;
  workerDesiredCount: number;
  /**
   * The S3 Tables <-> Glue/Lake Formation integration exists once per account and region.
   * "create" makes it in the lake stack; "existing" assumes it was set up already.
   */
  lakeIntegration: "create" | "existing";
  /** GuardDuty, Security Hub and Config are per account and region, like the lake integration. */
  securityServices: "create" | "existing";
}

export const STAGES: Record<Stage, StageConfig> = {
  dev: {
    stage: "dev",
    natGateways: 1,
    dbInstanceClass: "t4g.medium",
    dbMultiAz: false,
    dbBackupDays: 7,
    retainData: false,
    webDesiredCount: 1,
    apiDesiredCount: 1,
    gatewayDesiredCount: 1,
    workerDesiredCount: 1,
    lakeIntegration: "create",
    securityServices: "create",
  },
  prod: {
    stage: "prod",
    natGateways: 2,
    dbInstanceClass: "m7g.large",
    dbMultiAz: true,
    dbBackupDays: 30,
    retainData: true,
    webDesiredCount: 2,
    apiDesiredCount: 2,
    gatewayDesiredCount: 2,
    workerDesiredCount: 1,
    // Prod shares the account-level integration with dev when both live in one account.
    lakeIntegration: "existing",
    securityServices: "existing",
  },
};

export function stageConfig(stage: unknown): StageConfig {
  if (stage !== "dev" && stage !== "prod") throw new Error(`Unknown stage "${String(stage)}"`);
  return STAGES[stage];
}
