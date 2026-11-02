// Usage: pnpm --filter @mm/backtest backtest <tenant-id> [--train-end YYYY-MM-DD]
//          [--lake-dir DIR] [--skills] [--overlaps] [--max-tasks N] [--out FILE]
// Prints the pilot backtest report as Markdown (or writes it to --out). The default split is
// three months before today.
//   --skills    labels test-window work against skills learned before the split (Claude
//               Haiku on Bedrock; costs a model call per task, capped by --max-tasks per skill)
//   --overlaps  replays pull request history through the overlap rule (needs DATABASE_URL)
// Reads the lake (local files, or Athena when MM_LAKE_TABLE_BUCKET_ARN is set).
import { writeFileSync } from "node:fs";
import { assertTenantId, createDb, databaseSslFromEnv, databaseUrlFromEnv } from "@mm/db";
import { localLake, type LakeAdmin } from "@mm/lake";
import { athenaLake } from "@mm/lake/aws";
import { bedrockTransport, createLlm, dbCallLogger, modelConfigFromEnv } from "@mm/llm";
import { llmLabeller, skillLift, type SkillLift } from "../lift.ts";
import { loadBacktestSkills, loadPrHistory, loadTestTasks } from "../load.ts";
import { replayOverlaps } from "../overlaps.ts";
import { renderPilotReport } from "../pilot.ts";
import { buildReport } from "../report.ts";

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

const bucketArn = process.env.MM_LAKE_TABLE_BUCKET_ARN;
const lake: Pick<LakeAdmin, "scan"> = bucketArn
  ? athenaLake({
      stage: process.env.MM_STAGE ?? "dev",
      region: process.env.AWS_REGION ?? "us-east-1",
      accountId: bucketArn.split(":")[4]!,
      tableBucketName: bucketArn.split("/").pop()!,
    })
  : localLake({ dir: flag("--lake-dir") ?? ".data/lake" });

const wantSkills = args.includes("--skills");
const wantOverlaps = args.includes("--overlaps");
const url = databaseUrlFromEnv();
if ((wantSkills || wantOverlaps) && !url)
  throw new Error("--skills and --overlaps need DATABASE_URL.");
const db = url ? createDb({ connectionString: url, ssl: databaseSslFromEnv() }) : null;

try {
  const base = await buildReport(lake, tenantId, { trainEnd });
  let lifts: SkillLift[] | null = null;
  if (wantSkills && db) {
    const llm = createLlm({
      transport: bedrockTransport({ awsRegion: process.env.AWS_REGION }),
      models: modelConfigFromEnv(),
      log: dbCallLogger(db),
    });
    const label = llmLabeller(llm, tenantId);
    const tasks = await loadTestTasks(lake, tenantId, trainEnd);
    lifts = [];
    for (const skill of await loadBacktestSkills(db, tenantId, trainEnd)) {
      lifts.push(
        await skillLift(skill, tasks, label, {
          trainEnd,
          maxTasks: Number(flag("--max-tasks") ?? 200),
        }),
      );
      console.error(`- labelled ${skill.title}`);
    }
  }
  const overlaps =
    wantOverlaps && db
      ? replayOverlaps(await loadPrHistory(db, tenantId), { from: trainEnd })
      : null;
  const md = renderPilotReport({ base, lifts, overlaps, testFrom: trainEnd.toISOString() });
  const out = flag("--out");
  if (out) {
    writeFileSync(out, md);
    console.error(`wrote ${out}`);
  } else process.stdout.write(md);
} finally {
  await db?.close();
}
