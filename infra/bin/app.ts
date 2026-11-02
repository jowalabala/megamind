import { App, Tags } from "aws-cdk-lib";
import { AppStack } from "../lib/app-stack.ts";
import { stageConfig } from "../lib/config.ts";
import { DataStack } from "../lib/data-stack.ts";
import { LakeStack } from "../lib/lake-stack.ts";
import { NetworkStack } from "../lib/network-stack.ts";
import { SecurityStack } from "../lib/security-stack.ts";

const app = new App();
const cfg = stageConfig(app.node.tryGetContext("stage"));
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};
const prefix = `MasterMind-${cfg.stage}`;

const network = new NetworkStack(app, `${prefix}-Network`, cfg, { env });
const data = new DataStack(app, `${prefix}-Data`, cfg, { env, vpc: network.vpc });
const lake = new LakeStack(app, `${prefix}-Lake`, cfg, { env });
const security = new SecurityStack(app, `${prefix}-Security`, cfg, {
  env,
  bronzeBucket: data.bronzeBucket,
  alertEmail: app.node.tryGetContext("alertEmail"),
});
new AppStack(app, `${prefix}-App`, cfg, {
  env,
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
    resultsBucketName: lake.resultsBucketName,
  },
  evidenceBucket: security.evidenceBucket,
});

Tags.of(app).add("project", "master-mind");
Tags.of(app).add("stage", cfg.stage);
Tags.of(app).add("data-classification", "confidential");
