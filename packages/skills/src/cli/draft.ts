// Usage: pnpm --filter @mm/skills draft <tenant-id> [--train-end YYYY-MM-DD] [--lake-dir DIR]
// Builds cohorts from the lake's training window, asks Claude (Sonnet on Bedrock) for one
// skill per cohort, and stores the drafts. Prints what happened per category.
import { assertTenantId, createDb, databaseSslFromEnv, databaseUrlFromEnv } from "@mm/db";
import { localLake, type LakeAdmin } from "@mm/lake";
import { athenaLake } from "@mm/lake/aws";
import { bedrockTransport, createLlm, dbCallLogger, modelConfigFromEnv } from "@mm/llm";
import { draftSkills } from "../draft.ts";
import { gateDraft } from "../gate.ts";

const args = process.argv.slice(2);
const tenantId = args[0];
assertTenantId(tenantId);
const flag = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const trainEnd = flag("--train-end")
  ? new Date(flag("--train-end")!)
  : new Date(Date.now() - 91 * 86_400_000);
if (Number.isNaN(trainEnd.getTime())) throw new Error("--train-end must be a date (YYYY-MM-DD)");
const url = databaseUrlFromEnv();
if (!url) throw new Error("DATABASE_URL is required.");

const db = createDb({ connectionString: url, ssl: databaseSslFromEnv() });
const bucketArn = process.env.MM_LAKE_TABLE_BUCKET_ARN;
const lake: Pick<LakeAdmin, "scan"> = bucketArn
  ? athenaLake({
      stage: process.env.MM_STAGE ?? "dev",
      region: process.env.AWS_REGION ?? "us-east-1",
      accountId: bucketArn.split(":")[4]!,
      tableBucketName: bucketArn.split("/").pop()!,
    })
  : localLake({ dir: flag("--lake-dir") ?? ".data/lake" });
const llm = createLlm({
  transport: bedrockTransport({ awsRegion: process.env.AWS_REGION }),
  models: modelConfigFromEnv(),
  log: dbCallLogger(db),
});
try {
  for (const o of await draftSkills({ db, lake, llm }, tenantId, { trainEnd })) {
    let gate = "";
    if (o.result === "drafted" && o.draftId) {
      // Re-scan, verify each step against its evidence, score, then merge or create the skill.
      const g = await gateDraft({ db, llm }, tenantId, o.draftId);
      gate =
        g.status === "accepted"
          ? ` -> skill (${g.relation}, v${g.version})`
          : ` -> rejected (${g.reason})`;
    }
    console.log(
      `${o.pack}/${o.category}: ${o.result}${o.title ? ` - "${o.title}"` : ""}${gate} (${o.successes} successes vs ${o.failures}; ${o.droppedCitations} bad citations removed)`,
    );
  }
} finally {
  await db.close();
}
