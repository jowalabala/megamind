// Agreement between hand labels and what the system computed, per label and overall.
// The week 5 bar: >= 85% on 50 hand-labelled PRs.
import { sql, type MasterMindDb } from "@mm/db";

export interface HandLabel {
  repo: string;
  number: number;
  reverted?: boolean;
  escaped_defect?: boolean;
  ci_first_pass?: boolean;
  verdict?: string;
}

export type LabelName = "reverted" | "escaped_defect" | "ci_first_pass" | "verdict";
const LABELS: LabelName[] = ["reverted", "escaped_defect", "ci_first_pass", "verdict"];

export interface Disagreement {
  repo: string;
  number: number;
  label: LabelName;
  human: string;
  system: string;
}

export interface AgreementReport {
  prs: number;
  perLabel: Record<LabelName, { compared: number; agreed: number; rate: number | null }>;
  overall: { compared: number; agreed: number; rate: number | null };
  disagreements: Disagreement[];
  /** Labelled PRs the system has no data for (not imported, or not mature yet). */
  missing: { repo: string; number: number }[];
}

const BOOL = (v: string) => {
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(s)) return true;
  if (["0", "false", "no", "n"].includes(s)) return false;
  return undefined;
};

/** CSV with a header: repo,number[,reverted][,escaped_defect][,ci_first_pass][,verdict]. Blank = unlabelled. */
export function parseLabelsCsv(text: string): HandLabel[] {
  const [header, ...rows] = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  if (!header) return [];
  const cols = header.split(",").map((c) => c.trim().toLowerCase());
  if (!cols.includes("repo") || !cols.includes("number"))
    throw new Error("CSV needs repo and number columns");
  return rows.map((row, i) => {
    const cells = row.split(",");
    const get = (c: string) => cells[cols.indexOf(c)]?.trim() ?? "";
    const number = Number(get("number"));
    if (!Number.isInteger(number) || number <= 0) throw new Error(`Row ${i + 2}: bad PR number`);
    const label: HandLabel = { repo: get("repo").toLowerCase(), number };
    for (const b of ["reverted", "escaped_defect", "ci_first_pass"] as const) {
      if (cols.includes(b) && get(b)) label[b] = BOOL(get(b));
    }
    if (cols.includes("verdict") && get("verdict")) label.verdict = get("verdict").toLowerCase();
    return label;
  });
}

export async function compareLabels(
  db: MasterMindDb,
  tenantId: string,
  labels: HandLabel[],
  pack = "engineering",
): Promise<AgreementReport> {
  const rows = await db.withTenant(tenantId, (tx) =>
    tx.execute<{
      repo: string;
      number: number;
      metrics: Record<string, number> | null;
      verdict: string | null;
    }>(sql`
      SELECT p.repo, p.number,
             (SELECT jsonb_object_agg(m.metric_key, m.value) FROM (
                SELECT DISTINCT ON (metric_key) metric_key, value FROM metric_observations
                 WHERE task_id = p.task_id ORDER BY metric_key, observed_at DESC) m) AS metrics,
             (SELECT j.verdict FROM judgments j WHERE j.task_id = p.task_id AND j.pack = ${pack}
               ORDER BY j.ruleset_version DESC LIMIT 1) AS verdict
        FROM github_pull_requests p
       WHERE p.metrics_final_at IS NOT NULL`),
  );
  const byKey = new Map(rows.rows.map((r) => [`${r.repo}#${r.number}`, r]));

  const perLabel = Object.fromEntries(
    LABELS.map((l) => [l, { compared: 0, agreed: 0, rate: null as number | null }]),
  ) as AgreementReport["perLabel"];
  const disagreements: Disagreement[] = [];
  const missing: AgreementReport["missing"] = [];

  for (const h of labels) {
    const sys = byKey.get(`${h.repo}#${h.number}`);
    if (!sys) {
      missing.push({ repo: h.repo, number: h.number });
      continue;
    }
    const metric = (k: string) =>
      sys.metrics?.[k] === undefined ? undefined : String(Boolean(Number(sys.metrics[k])));
    const system: Record<LabelName, string | undefined> = {
      reverted: metric("pr.reverted"),
      escaped_defect: metric("pr.escaped_defect"),
      ci_first_pass: metric("ci.first_pass"),
      verdict: sys.verdict ?? "not_judged",
    };
    for (const l of LABELS) {
      if (h[l] === undefined) continue;
      const human = String(h[l]);
      const s = system[l] ?? "unknown";
      perLabel[l].compared++;
      if (human === s) perLabel[l].agreed++;
      else disagreements.push({ repo: h.repo, number: h.number, label: l, human, system: s });
    }
  }
  let compared = 0;
  let agreed = 0;
  for (const l of LABELS) {
    const p = perLabel[l];
    p.rate = p.compared ? p.agreed / p.compared : null;
    compared += p.compared;
    agreed += p.agreed;
  }
  return {
    prs: labels.length - missing.length,
    perLabel,
    overall: { compared, agreed, rate: compared ? agreed / compared : null },
    disagreements,
    missing,
  };
}
