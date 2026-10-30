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
  },
  prod: {
    stage: "prod",
    natGateways: 2,
    dbInstanceClass: "m7g.large",
    dbMultiAz: true,
    dbBackupDays: 30,
    retainData: true,
    webDesiredCount: 2,
  },
};

export function stageConfig(stage: unknown): StageConfig {
  if (stage !== "dev" && stage !== "prod") throw new Error(`Unknown stage "${String(stage)}"`);
  return STAGES[stage];
}
