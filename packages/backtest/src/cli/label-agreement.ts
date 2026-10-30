// Usage: pnpm --filter @mm/backtest label-agreement <tenant-id> <labels.csv>
// Compares hand labels (repo,number,reverted,escaped_defect,ci_first_pass,verdict) with what
// the system computed, and prints agreement per label and overall. The bar is 85%.
import { readFileSync } from "node:fs";
import { assertTenantId, createDb, databaseSslFromEnv, databaseUrlFromEnv } from "@mm/db";
import { compareLabels, parseLabelsCsv } from "../labels.ts";

const [tenantId, file] = process.argv.slice(2);
assertTenantId(tenantId);
if (!file) throw new Error("Pass the labels CSV file.");
const url = databaseUrlFromEnv();
if (!url) throw new Error("DATABASE_URL is required.");
const db = createDb({ connectionString: url, ssl: databaseSslFromEnv() });
try {
  const r = await compareLabels(db, tenantId, parseLabelsCsv(readFileSync(file, "utf8")));
  const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
  console.log(`PRs compared: ${r.prs} (${r.missing.length} labelled PRs have no final data yet)`);
  for (const [label, s] of Object.entries(r.perLabel)) {
    console.log(`  ${label.padEnd(15)} ${pct(s.rate)} (${s.agreed}/${s.compared})`);
  }
  console.log(
    `Overall: ${pct(r.overall.rate)} (${r.overall.agreed}/${r.overall.compared})  bar: 85%`,
  );
  for (const d of r.disagreements) {
    console.log(`  ${d.repo}#${d.number} ${d.label}: human=${d.human} system=${d.system}`);
  }
  process.exitCode = r.overall.rate !== null && r.overall.rate >= 0.85 ? 0 : 1;
} finally {
  await db.close();
}
