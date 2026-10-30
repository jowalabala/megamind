// Drafts skills for a tenant from a training window: cohorts from the lake, one extraction
// per cohort, drafts stored for review. Re-running the same window and prompt version is a
// no-op (same draft id).
import { idFromKey, skillDrafts, type MasterMindDb } from "@mm/db";
import type { LakeAdmin } from "@mm/lake";
import type { Llm } from "@mm/llm";
import { buildCohorts, type CohortOptions } from "./cohort.ts";
import { extractPrompt, extractSkill } from "./extract.ts";

export interface DraftOutcome {
  pack: string;
  category: string;
  successes: number;
  failures: number;
  result: "drafted" | "exists" | "no_clear_practice" | "too_few_grounded_steps";
  draftId?: string;
  title?: string;
  droppedCitations: number;
}

/** Below this many successes, a draft is flagged as low confidence. */
export const CONFIDENT_SUCCESSES = 8;

export async function draftSkills(
  deps: {
    db: MasterMindDb;
    lake: Pick<LakeAdmin, "scan">;
    llm: Llm;
    log?: (e: string, f: Record<string, unknown>) => void;
  },
  tenantId: string,
  options: CohortOptions,
): Promise<DraftOutcome[]> {
  const cohorts = await buildCohorts(deps.lake, tenantId, options);
  const out: DraftOutcome[] = [];
  for (const c of cohorts) {
    const base = {
      pack: c.pack,
      category: c.category,
      successes: c.success.length,
      failures: c.failure.length,
    };
    const id = idFromKey([
      tenantId,
      "skill_draft",
      c.pack,
      c.category,
      c.windowFrom ?? "",
      c.windowTo,
      extractPrompt.id,
      String(extractPrompt.version),
    ]);
    const res = await extractSkill(deps.llm, c, tenantId);
    if (!res.ok) {
      out.push({ ...base, result: res.reason, droppedCitations: res.droppedCitations });
      continue;
    }
    const inserted = await deps.db.withTenant(tenantId, (tx) =>
      tx
        .insert(skillDrafts)
        .values({
          id,
          tenantId,
          pack: c.pack,
          category: c.category,
          windowFrom: c.windowFrom ? new Date(c.windowFrom) : null,
          windowTo: new Date(c.windowTo),
          title: res.draft.title,
          body: res.draft.body,
          cohort: {
            success: c.success.map((t) => t.taskId),
            failure: c.failure.map((t) => t.taskId),
            hints: c.hints,
          },
          droppedCitations: res.draft.droppedCitations,
          lowConfidence: c.success.length < CONFIDENT_SUCCESSES,
          promptId: extractPrompt.id,
          promptVersion: extractPrompt.version,
        })
        .onConflictDoNothing()
        .returning({ id: skillDrafts.id }),
    );
    out.push({
      ...base,
      result: inserted.length ? "drafted" : "exists",
      draftId: id,
      title: res.draft.title,
      droppedCitations: res.draft.droppedCitations,
    });
  }
  deps.log?.("skills.drafted", {
    tenantId,
    cohorts: cohorts.length,
    drafted: out.filter((o) => o.result === "drafted").length,
  });
  return out;
}
