"use server";

// The generic pack editor and CSV outcome uploads. Admins only. Every change validates the
// whole pack and stores a new version, so the rules that judged earlier work are kept.
import { appendAuditEvent } from "@mm/audit";
import { packRepo, PackVersionConflictError } from "@mm/db";
import {
  CsvError,
  CSV_LIMITS,
  editablePack,
  importOutcomes,
  PackError,
  packToYaml,
  parseTenantPack,
  type Pack,
} from "@mm/packs";
import { revalidatePath } from "next/cache";
import { requireMemberContext } from "../../../lib/context";
import { db } from "../../../lib/db";
import { freshPacks, redactorFor } from "../../../lib/packs";

export type FormState =
  { error?: string; ok?: string; problems?: { line: number; problem: string }[] } | undefined;

const str = (f: FormData, k: string, max = 300) =>
  String(f.get(k) ?? "")
    .trim()
    .slice(0, max);
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^([0-9])/, "c_$1")
    .slice(0, 60);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function admin() {
  const ctx = await requireMemberContext();
  if (ctx.member.role !== "admin") throw new Error("Only admins can change metrics.");
  return ctx;
}

/** Applies `change` to the latest generic pack and stores the result as a new version. */
async function update(formData: FormData, change: (p: Pack) => Pack | string): Promise<FormState> {
  const ctx = await admin();
  const expected = Number(formData.get("version"));
  const { pack, version } = await editablePack(db(), ctx.tenantId, "generic");
  if (version !== expected)
    return { error: "Someone changed these metrics meanwhile. Reload and try again." };
  const next = change(structuredClone(pack));
  if (typeof next === "string") return { error: next };
  return save(ctx, packToYaml(next), version);
}

async function save(
  ctx: Awaited<ReturnType<typeof admin>>,
  yamlText: string,
  version: number,
): Promise<FormState> {
  let parsed;
  try {
    parsed = parseTenantPack(yamlText, version + 1);
  } catch (err) {
    if (err instanceof PackError) return { error: err.message };
    throw err;
  }
  try {
    await db().withTenant(ctx.tenantId, async (tx) => {
      await packRepo.savePackVersion(tx, ctx.tenantId, {
        packId: "generic",
        yaml: parsed.yaml,
        expectedVersion: version,
        memberId: ctx.member.id,
      });
      await appendAuditEvent(tx, ctx.tenantId, {
        actorType: "member",
        actorId: ctx.member.id,
        action: "pack.updated",
        targetType: "pack",
        targetId: "generic",
        payload: {
          version: version + 1,
          categories: parsed.pack.categories.length,
          metrics: parsed.pack.metrics.length,
        },
      });
    });
  } catch (err) {
    if (err instanceof PackVersionConflictError) return { error: err.message };
    throw err;
  }
  revalidatePath("/settings/metrics");
  return { ok: `Saved as version ${version + 1}. New work is judged by these rules.` };
}

export async function addCategory(_prev: FormState, f: FormData): Promise<FormState> {
  const name = str(f, "name", 100);
  const description = str(f, "description", 500);
  const keywords = str(f, "keywords", 500)
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 20);
  if (!name || !description) return { error: "A category needs a name and a description." };
  const id = slug(name);
  if (!/^[a-z]/.test(id)) return { error: "Start the name with a letter." };
  return update(f, (p) => {
    if (p.categories.some((c) => c.id === id)) return `There is already a category called ${name}.`;
    const rules = keywords.length
      ? [{ title: `(${keywords.map(escapeRe).join("|")})`.slice(0, 200) }]
      : [];
    // New categories go before the fallback, which stays last.
    const at = Math.max(
      0,
      p.categories.findIndex((c) => c.id === p.fallback),
    );
    p.categories.splice(at, 0, { id, name, description, rules });
    return p;
  });
}

export async function addMetric(_prev: FormState, f: FormData): Promise<FormState> {
  const id = str(f, "id", 100).toLowerCase();
  const description = str(f, "description", 300);
  const unit = str(f, "unit") as Pack["metrics"][number]["unit"];
  const better = str(f, "better") as "higher" | "lower";
  const windowDays = str(f, "window_days");
  if (!/^[a-z][a-z0-9_.]{0,99}$/.test(id)) {
    return {
      error:
        "Metric ids are lowercase letters, digits, dots and underscores, like invoice.days_to_pay.",
    };
  }
  if (!["ratio", "count", "hours", "boolean"].includes(unit)) return { error: "Pick a unit." };
  if (!["higher", "lower"].includes(better))
    return { error: "Say whether higher or lower is better." };
  return update(f, (p) => {
    if (p.metrics.some((m) => m.id === id)) return `There is already a metric called ${id}.`;
    p.metrics.push({
      id,
      description: description || id,
      unit,
      better,
      ...(windowDays ? { window_days: Math.max(0, Math.min(365, Number(windowDays) || 0)) } : {}),
    });
    return p;
  });
}

export async function addRule(_prev: FormState, f: FormData): Promise<FormState> {
  const kind = str(f, "kind");
  const metric = str(f, "metric", 100);
  const op = str(f, "op") as "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
  const against = str(f, "against");
  const value = Number(str(f, "value"));
  if (!["success", "failure"].includes(kind)) return { error: "Pick success or failure." };
  if (!["eq", "ne", "lt", "lte", "gt", "gte"].includes(op)) return { error: "Pick a comparison." };
  const condition =
    against === "value"
      ? Number.isFinite(value) && str(f, "value") !== ""
        ? { metric, op, value }
        : null
      : ["p25", "p50", "p75", "mean"].includes(against)
        ? { metric, op, baseline: against as "p25" | "p50" | "p75" | "mean" }
        : null;
  if (!condition)
    return { error: "Give a number, or pick the team's own history to compare with." };
  return update(f, (p) => {
    if (!p.metrics.some((m) => m.id === metric)) return "Add the metric first.";
    if (!p.judge && kind === "failure")
      return "Add a success rule first: it says what good work looks like.";
    const judge = p.judge ?? {
      version: 1,
      requires: [metric],
      skip_categories: [],
      failure_if_any: [],
      success_if_all: [],
      baseline: { days: 180, min_samples: 20 },
    };
    (kind === "success" ? judge.success_if_all : judge.failure_if_any).push(condition);
    judge.requires = [
      ...new Set([...judge.success_if_all, ...judge.failure_if_any].map((c) => c.metric)),
    ];
    p.judge = judge;
    return p;
  });
}

export async function removeItem(_prev: FormState, f: FormData): Promise<FormState> {
  const what = str(f, "what");
  const id = str(f, "id", 100);
  const index = Number(str(f, "index"));
  return update(f, (p) => {
    if (what === "category") {
      if (id === p.fallback) return "The fallback category can't be removed.";
      p.categories = p.categories.filter((c) => c.id !== id);
      if (p.judge) p.judge.skip_categories = p.judge.skip_categories.filter((c) => c !== id);
    } else if (what === "metric") {
      const used = [...(p.judge?.success_if_all ?? []), ...(p.judge?.failure_if_any ?? [])].some(
        (c) => c.metric === id,
      );
      if (used) return "Remove the rules that use this metric first.";
      p.metrics = p.metrics.filter((m) => m.id !== id);
    } else if (what === "success" || what === "failure") {
      if (!p.judge) return "There are no rules.";
      const list = what === "success" ? p.judge.success_if_all : p.judge.failure_if_any;
      list.splice(index, 1);
      if (p.judge.success_if_all.length === 0) {
        delete p.judge;
      } else {
        p.judge.requires = [
          ...new Set([...p.judge.success_if_all, ...p.judge.failure_if_any].map((c) => c.metric)),
        ];
      }
    }
    return p;
  });
}

export async function saveYaml(_prev: FormState, f: FormData): Promise<FormState> {
  const ctx = await admin();
  const expected = Number(f.get("version"));
  const yamlText = String(f.get("yaml") ?? "");
  if (yamlText.length > 200_000) return { error: "That pack is too long." };
  return save(ctx, yamlText, expected);
}

export async function uploadOutcomes(_prev: FormState, f: FormData): Promise<FormState> {
  const ctx = await admin();
  const file = f.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file." };
  if (file.size > CSV_LIMITS.bytes) return { error: "The file is larger than 2 MB; split it." };
  try {
    const result = await importOutcomes(
      { db: db(), packs: freshPacks(), redactorFor },
      ctx.tenantId,
      ctx.member.id,
      await file.text(),
    );
    await db().withTenant(ctx.tenantId, (tx) =>
      appendAuditEvent(tx, ctx.tenantId, {
        actorType: "member",
        actorId: ctx.member.id,
        action: "outcomes.imported",
        targetType: "outcome_import",
        targetId: result.importId,
        payload: { rows: result.rows, stored: result.stored, created_tasks: result.createdTasks },
      }),
    );
    revalidatePath("/settings/metrics");
    return {
      ok: `Read ${result.rows} row(s): stored ${result.stored} outcome(s)${
        result.createdTasks ? `, added ${result.createdTasks} unit(s) of work` : ""
      }${result.problems.length ? `; ${result.problems.length} row(s) need fixing` : ""}.`,
      problems: result.problems.slice(0, 50),
    };
  } catch (err) {
    if (err instanceof CsvError) return { error: err.message };
    throw err;
  }
}
