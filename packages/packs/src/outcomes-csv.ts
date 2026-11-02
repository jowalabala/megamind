// Outcomes from a CSV upload: the generic pack's way in for teams whose results live in a
// spreadsheet (finance, HR, ops). Each row is one metric value for one unit of work.
//
//   ref,metric,value[,n][,observed_at][,title][,owner_email][,completed_at][,category]
//
// `ref` names the work: an external ref (jira:issue:FIN-12, sheet:row:12) or a task id. A row whose
// ref matches no task creates one when it has a title and the owner's work email. Only
// metrics defined in the tenant's packs are accepted, and values must fit the metric's unit.
// Problems are reported per line without echoing cell values.
import { randomUUID } from "node:crypto";
import {
  eq,
  externalRefs,
  idFromKey,
  inArray,
  members,
  metricObservations,
  outcomeImports,
  sql,
  tasks,
  type ImportProblem,
  type MasterMindDb,
  type TenantTx,
} from "@mm/db";
import {
  categoryRecord,
  enqueueLakeRecords,
  metricRecord,
  taskRecord,
  type LakeRecord,
} from "@mm/lake";
import type { Redactor } from "@mm/privacy";
import { categorize, choosePack } from "./categorize.ts";
import type { Pack } from "./schema.ts";
import { resolvePacks, type PackSource } from "./tenant.ts";

export const CSV_LIMITS = { bytes: 2_000_000, rows: 5_000, problems: 200 };
const COLUMNS = [
  "ref",
  "metric",
  "value",
  "n",
  "observed_at",
  "title",
  "owner_email",
  "completed_at",
  "category",
] as const;
type Column = (typeof COLUMNS)[number];
const REQUIRED: Column[] = ["ref", "metric", "value"];
/** Same shape as external_refs everywhere: system:kind:id. */
const REF_RE = /^[a-z][a-z0-9_]{0,30}:[a-z][a-z0-9_]{0,30}:[^\s,]{1,400}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CsvError extends Error {
  override name = "CsvError";
}

/** RFC 4180: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (i < s.length) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += ch;
      }
      i++;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      row.push(field);
      field = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      if (ch === "\r" && s[i + 1] === "\n") i++;
    } else field += ch;
    i++;
  }
  if (quoted) throw new CsvError("A quoted field is never closed.");
  row.push(field);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

export interface OutcomeRow {
  line: number;
  ref: string;
  metric: string;
  value: number;
  n: number;
  observedAt: Date | null;
  title: string | null;
  ownerEmail: string | null;
  completedAt: Date | null;
  category: string | null;
}

const date = (v: string) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/** Parses and checks the file's shape. Rows with problems are reported, not returned. */
export function readOutcomeCsv(text: string): {
  rows: OutcomeRow[];
  problems: ImportProblem[];
  total: number;
} {
  if (Buffer.byteLength(text) > CSV_LIMITS.bytes) {
    throw new CsvError(`The file is larger than ${CSV_LIMITS.bytes / 1_000_000} MB.`);
  }
  const table = parseCsv(text);
  if (table.length === 0) throw new CsvError("The file is empty.");
  const header = table[0]!.map((h) => h.trim().toLowerCase());
  const unknown = header.filter((h) => !(COLUMNS as readonly string[]).includes(h));
  if (unknown.length) {
    throw new CsvError(
      `Unknown column(s): ${unknown.slice(0, 5).join(", ")}. Allowed: ${COLUMNS.join(", ")}.`,
    );
  }
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) throw new CsvError(`Missing column(s): ${missing.join(", ")}.`);
  if (table.length - 1 > CSV_LIMITS.rows) {
    throw new CsvError(`At most ${CSV_LIMITS.rows} rows per file; split it into several uploads.`);
  }
  const at = (cells: string[], c: Column) => {
    const i = header.indexOf(c);
    return i < 0 ? "" : (cells[i] ?? "").trim();
  };

  const rows: OutcomeRow[] = [];
  const problems: ImportProblem[] = [];
  table.slice(1).forEach((cells, idx) => {
    const line = idx + 2;
    const bad = (problem: string) => problems.push({ line, problem });
    const ref = at(cells, "ref");
    if (!REF_RE.test(ref) && !UUID_RE.test(ref)) {
      return bad("ref must be a reference like jira:issue:FIN-12 or a task id");
    }
    const metric = at(cells, "metric");
    if (!/^[a-z][a-z0-9_.]{0,99}$/.test(metric)) return bad("metric is not a valid metric id");
    const raw = at(cells, "value").toLowerCase();
    const value =
      raw === "true" || raw === "yes" ? 1 : raw === "false" || raw === "no" ? 0 : Number(raw);
    if (raw === "" || !Number.isFinite(value)) return bad("value must be a number");
    const nRaw = at(cells, "n");
    const n = nRaw ? Number(nRaw) : 1;
    if (!Number.isInteger(n) || n < 1 || n > 10_000_000) return bad("n must be a whole number ≥ 1");
    const observedAt = date(at(cells, "observed_at"));
    const completedAt = date(at(cells, "completed_at"));
    if (observedAt === undefined) return bad("observed_at is not a date");
    if (completedAt === undefined) return bad("completed_at is not a date");
    const title = at(cells, "title").slice(0, 300) || null;
    const ownerEmail = at(cells, "owner_email").toLowerCase() || null;
    if (ownerEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) {
      return bad("owner_email is not an email address");
    }
    const category = at(cells, "category").slice(0, 100) || null;
    rows.push({
      line,
      ref,
      metric,
      value,
      n,
      observedAt,
      title,
      ownerEmail,
      completedAt,
      category,
    });
  });
  return { rows, problems, total: table.length - 1 };
}

/** Checks a value against the metric's unit. Null when fine, else the problem. */
export function unitProblem(unit: Pack["metrics"][number]["unit"], value: number): string | null {
  if (unit === "boolean" && value !== 0 && value !== 1) return "this metric is yes/no (1 or 0)";
  if (unit === "ratio" && (value < 0 || value > 1)) return "this metric is a ratio between 0 and 1";
  if ((unit === "count" || unit === "hours") && value < 0) return "this metric can't be negative";
  return null;
}

export interface ImportDeps {
  db: MasterMindDb;
  packs: PackSource;
  redactorFor: (tenantId: string) => Promise<Redactor>;
  now?: () => Date;
}

export interface ImportResult {
  importId: string;
  rows: number;
  stored: number;
  createdTasks: number;
  problems: ImportProblem[];
}

const AGENT_SOURCES = new Set(["mcp", "bridge"]);

/** Finds the task each ref names. A connector's task wins over an agent's with the same ref. */
async function resolveRefs(tx: TenantTx, refs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = refs.filter((r) => UUID_RE.test(r));
  if (ids.length) {
    const found = await tx.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, ids));
    for (const t of found) out.set(t.id, t.id);
  }
  const named = refs.filter((r) => !UUID_RE.test(r));
  if (named.length) {
    const found = await tx
      .select({ ref: externalRefs.ref, taskId: externalRefs.taskId, source: tasks.source })
      .from(externalRefs)
      .innerJoin(
        tasks,
        sql`${tasks.tenantId} = ${externalRefs.tenantId} AND ${tasks.id} = ${externalRefs.taskId}`,
      )
      .where(inArray(externalRefs.ref, named));
    for (const f of found) {
      const prev = out.get(f.ref);
      if (!prev || !AGENT_SOURCES.has(f.source)) out.set(f.ref, f.taskId);
    }
  }
  return out;
}

export async function importOutcomes(
  deps: ImportDeps,
  tenantId: string,
  memberId: string,
  csvText: string,
): Promise<ImportResult> {
  const now = deps.now?.() ?? new Date();
  const { rows, problems, total } = readOutcomeCsv(csvText);
  const { current } = await resolvePacks(deps.packs, tenantId);
  const metricDefs = new Map(current.flatMap((p) => p.metrics.map((m) => [m.id, m] as const)));
  const redactor = await deps.redactorFor(tenantId);
  const bad = (line: number, problem: string) => problems.push({ line, problem });

  // Redact titles before opening the transaction (the redactor may call out to Comprehend).
  const titles = new Map<number, { text: string; counts: Record<string, number> }>();
  for (const r of rows) {
    if (r.title) titles.set(r.line, await redactor.redact(r.title));
  }

  const result = await deps.db.withTenant(tenantId, async (tx) => {
    const refs = await resolveRefs(tx, [...new Set(rows.map((r) => r.ref))]);
    const emails = [...new Set(rows.map((r) => r.ownerEmail).filter((e): e is string => !!e))];
    const people = emails.length
      ? await tx
          .select({ id: members.id, email: members.email, optOut: members.captureOptOut })
          .from(members)
          .where(inArray(sql`lower(${members.email})`, emails))
      : [];
    const byEmail = new Map(people.map((p) => [p.email.toLowerCase(), p]));
    const owners = new Map<string, string | null>();
    const lake: LakeRecord[] = [];
    let stored = 0;
    let createdTasks = 0;

    for (const r of rows) {
      const def = metricDefs.get(r.metric);
      if (!def) {
        bad(r.line, "metric isn't defined in any of your packs; add it under Settings → Metrics");
        continue;
      }
      const unit = unitProblem(def.unit, r.value);
      if (unit) {
        bad(r.line, unit);
        continue;
      }
      let taskId = refs.get(r.ref);
      if (!taskId) {
        if (UUID_RE.test(r.ref) || !r.title || !r.ownerEmail) {
          bad(r.line, "no work with this ref yet; add title and owner_email to create it");
          continue;
        }
        const owner = byEmail.get(r.ownerEmail);
        if (!owner) {
          bad(r.line, "owner_email isn't a member of this organization");
          continue;
        }
        if (owner.optOut) {
          bad(r.line, "the owner has opted out of capture, so this row was skipped");
          continue;
        }
        const created = await createTask(
          tx,
          tenantId,
          current,
          r,
          owner.id,
          titles.get(r.line)!,
          now,
        );
        lake.push(...created.lake);
        taskId = created.taskId;
        refs.set(r.ref, taskId);
        if (created.created) createdTasks++;
      }
      if (!owners.has(taskId)) {
        const [t] = await tx
          .select({ memberId: tasks.memberId })
          .from(tasks)
          .where(eq(tasks.id, taskId));
        owners.set(taskId, t?.memberId ?? null);
      }
      const observedAt = r.observedAt ?? now;
      // Same task, metric and time: uploading the same file twice stores nothing new.
      const id = idFromKey([taskId, r.metric, "csv", observedAt.toISOString()]);
      const inserted = await tx
        .insert(metricObservations)
        .values({
          id,
          tenantId,
          taskId,
          metricKey: r.metric,
          value: r.value,
          n: r.n,
          source: "csv",
          observedAt,
        })
        .onConflictDoNothing()
        .returning({ id: metricObservations.id });
      if (!inserted.length) continue;
      stored++;
      lake.push(
        metricRecord({
          id,
          tenantId,
          memberId: owners.get(taskId) ?? null,
          agentId: null,
          source: "csv",
          taskId,
          metric: r.metric,
          value: r.value,
          n: r.n,
          note: null,
          observedAt,
          ingestedAt: now,
        }),
      );
    }
    if (lake.length) await enqueueLakeRecords(tx, tenantId, lake);
    problems.sort((a, b) => a.line - b.line);
    const [imp] = await tx
      .insert(outcomeImports)
      .values({
        tenantId,
        memberId,
        rows: total,
        stored,
        problems: problems.slice(0, CSV_LIMITS.problems),
      })
      .returning({ id: outcomeImports.id });
    return { importId: imp!.id, stored, createdTasks };
  });
  return {
    ...result,
    rows: total,
    problems: problems.slice(0, CSV_LIMITS.problems),
  };
}

async function createTask(
  tx: TenantTx,
  tenantId: string,
  packs: Pack[],
  r: OutcomeRow,
  memberId: string,
  title: { text: string; counts: Record<string, number> },
  now: Date,
): Promise<{ taskId: string; created: boolean; lake: LakeRecord[] }> {
  const taskId = idFromKey([tenantId, "csv", r.ref]);
  const completedAt = r.completedAt ?? r.observedAt ?? now;
  const pack = choosePack(packs, {
    source: "csv",
    refSystems: [r.ref.split(":")[0]!],
    codeSession: false,
  });
  // Rules and the category column only: no model call while a transaction is open.
  const decision = await categorize(
    pack,
    {
      title: title.text,
      summary: "",
      labels: [],
      branch: null,
      files: [],
      authorIsBot: false,
      hint: r.category,
    },
    { llm: null, tenantId },
  );
  const summary = "Imported from a CSV of outcomes.";
  const inserted = await tx
    .insert(tasks)
    .values({
      id: taskId,
      tenantId,
      memberId,
      source: "csv",
      titleRedacted: title.text || "(untitled)",
      summaryRedacted: summary,
      redactionCounts: title.counts,
      categoryHint: r.category,
      startedAt: completedAt,
      completedAt,
      pack: decision.pack,
      category: decision.category,
      categorySource: decision.method,
      categoryConfidence: decision.confidence,
      state: "categorized",
    })
    .onConflictDoNothing()
    .returning({ id: tasks.id });
  if (!inserted.length) return { taskId, created: false, lake: [] };
  await tx.insert(externalRefs).values({ tenantId, taskId, ref: r.ref }).onConflictDoNothing();
  const common = { tenantId, memberId, agentId: null, source: "csv" as const, ingestedAt: now };
  return {
    taskId,
    created: true,
    lake: [
      taskRecord({
        ...common,
        id: taskId,
        sessionId: null,
        private: false,
        title: title.text,
        summary,
        categoryHint: r.category,
        externalRefs: [r.ref],
        features: {},
        startedAt: completedAt,
        completedAt,
        createdAt: now,
      }),
      categoryRecord({
        ...common,
        id: randomUUID(),
        taskId,
        pack: decision.pack,
        category: decision.category,
        method: decision.method,
        confidence: decision.confidence,
        categorizedAt: now,
      }),
    ],
  };
}
