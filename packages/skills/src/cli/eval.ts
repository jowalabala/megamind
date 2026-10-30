// Usage:
//   pnpm --filter @mm/skills eval            run the golden cases against Claude (Bedrock) and
//                                            write evals/results/skills.extract@<version>.json
//   pnpm --filter @mm/skills eval --lock     record the current prompt fingerprints after a
//                                            deliberate prompt change (with a version bump)
import { readFileSync, writeFileSync } from "node:fs";
import { bedrockTransport, createLlm, modelConfigFromEnv } from "@mm/llm";
import { extractPrompt } from "../extract.ts";
import { evalCase, fingerprint, gradeExtraction, GATED_PROMPTS } from "../evals.ts";

const dir = new URL("../../evals/", import.meta.url);
const cases = evalCase.array().parse(JSON.parse(readFileSync(new URL("cases.json", dir), "utf8")));

if (process.argv.includes("--lock")) {
  const lock = Object.fromEntries(
    GATED_PROMPTS.map((p) => [
      p.id,
      { version: p.version, fingerprint: fingerprint(p, cases[0]!.cohort) },
    ]),
  );
  writeFileSync(new URL("prompts.lock.json", dir), JSON.stringify(lock, null, 2) + "\n");
  console.log("prompts.lock.json updated");
  process.exit(0);
}

const models = modelConfigFromEnv();
const llm = createLlm({
  transport: bedrockTransport({ awsRegion: process.env.AWS_REGION }),
  models,
  log: async () => {},
});
const results = [];
for (const c of cases) {
  try {
    const out = await llm.run(extractPrompt, c.cohort, {
      tenantId: "00000000-0000-4000-8000-000000000000",
      stage: "eval",
    });
    const g = gradeExtraction(c, out);
    results.push({ id: c.id, ...g });
    console.log(
      `${g.pass ? "pass" : "FAIL"} ${c.id}${g.failures.length ? `: ${g.failures.join("; ")}` : ""}`,
    );
  } catch (err) {
    results.push({ id: c.id, pass: false, failures: [(err as Error).message] });
    console.log(`FAIL ${c.id}: ${(err as Error).message}`);
  }
}
const passRate = results.filter((r) => r.pass).length / results.length;
writeFileSync(
  new URL(`results/${extractPrompt.id}@${extractPrompt.version}.json`, dir),
  JSON.stringify(
    {
      prompt: extractPrompt.id,
      version: extractPrompt.version,
      fingerprint: fingerprint(extractPrompt, cases[0]!.cohort),
      model: models[extractPrompt.tier],
      ran_at: new Date().toISOString(),
      pass_rate: passRate,
      results,
    },
    null,
    2,
  ) + "\n",
);
console.log(`pass rate ${(passRate * 100).toFixed(1)}%`);
