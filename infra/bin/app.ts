import { App, Tags } from "aws-cdk-lib";
import { AppStack } from "../lib/app-stack.ts";
import { stageConfig } from "../lib/config.ts";
import { DataStack } from "../lib/data-stack.ts";
import { NetworkStack } from "../lib/network-stack.ts";

const app = new App();
const cfg = stageConfig(app.node.tryGetContext("stage"));
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};
const prefix = `MasterMind-${cfg.stage}`;

const network = new NetworkStack(app, `${prefix}-Network`, cfg, { env });
const data = new DataStack(app, `${prefix}-Data`, cfg, { env, vpc: network.vpc });
new AppStack(app, `${prefix}-App`, cfg, {
  env,
  vpc: network.vpc,
  db: data.db,
  dbSecurityGroup: data.dbSecurityGroup,
  appDbSecret: data.appDbSecret,
});

Tags.of(app).add("project", "master-mind");
Tags.of(app).add("stage", cfg.stage);
Tags.of(app).add("data-classification", "confidential");
