// The eval harness for skill prompts.
//
// Golden cases are small cohorts with known answers: what a good skill must cite, what it must
// never contain (injected instructions, people's details), and when there's no practice to find.
// Graders are deterministic, so live runs (Bedrock) are comparable across prompt versions.
//
// The CI gate (test/evals.test.ts):
//   - a prompt whose content changed must bump its version (fingerprints in prompts.lock.json);
//   - every golden case is well-formed and its graders pass an ideal answer and fail a bad one;
//   - once policy.require_live_results is on, each current prompt version needs a live result
//     with pass rate >= policy.min_pass_rate in evals/results/.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Cohort } from "./cohort.ts";
import { extractPrompt, groundDraft, type SkillDraftOutput } from "./extract.ts";
import { dedupePrompt, rubricPrompt, verifyPrompt } from "./gate.ts";

export const evalCase = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string(),
  cohort: z.custom<Cohort>(),
  expect: z.object({
    /** No consistent practice: the model should say so (or produce nothing grounded). */
    no_practice: z.boolean().default(false),
    /** Refs that show the practice; at least one step must cite >= 2 of them. */
    practice_refs: z.array(z.string()).default([]),
    /** Words that should appear in the skill (any of them), e.g. "test". */
    mentions_any: z.array(z.string()).default([]),
    /** Must never appear in the output (case-insensitive). */
    must_not_contain: z.array(z.string()).default([]),
  }),
});
export type EvalCase = z.infer<typeof evalCase>;

export interface Grade {
  pass: boolean;
  failures: string[];
}

export function gradeExtraction(c: EvalCase, out: SkillDraftOutput): Grade {
  const failures: string[] = [];
  const grounded = groundDraft(c.cohort, out);
  const text = JSON.stringify(out).toLowerCase();
  for (const bad of c.expect.must_not_contain) {
    if (text.includes(bad.toLowerCase())) failures.push(`contains "${bad}"`);
  }
  if (c.expect.no_practice) {
    if (grounded.ok) failures.push("found a practice where there is none");
    return { pass: failures.length === 0, failures };
  }
  if (!grounded.ok) {
    failures.push(`no grounded skill (${grounded.reason})`);
    return { pass: false, failures };
  }
  const want = new Set(c.expect.practice_refs);
  const hits = out.steps.some((s) => s.evidence.filter((r) => want.has(r)).length >= 2);
  if (want.size && !hits) failures.push("no step cites the tasks that show the practice");
  if (
    c.expect.mentions_any.length &&
    !c.expect.mentions_any.some((w) => text.includes(w.toLowerCase()))
  ) {
    failures.push(`mentions none of ${c.expect.mentions_any.join(", ")}`);
  }
  if (out.steps.some((s) => s.evidence.some((r) => r.startsWith("F"))))
    failures.push("a step cites a failure");
  return { pass: failures.length === 0, failures };
}

// --- Prompt fingerprints ----------------------------------------------------------------------

export const GATED_PROMPTS = [extractPrompt, verifyPrompt, rubricPrompt, dedupePrompt];

/** Content hash of a prompt: system text, a rendered sample and the output schema. */
export function fingerprint(p: (typeof GATED_PROMPTS)[number], sample: Cohort): string {
  const samples: Record<string, unknown> = {
    "skills.extract": sample,
    "skills.verify": {
      steps: [{ text: "step", evidence: [{ ref: "E1", title: "t", summary: "s" }] }],
    },
    "skills.rubric": {
      title: "t",
      body: {
        when_to_use: "w",
        preconditions: [],
        steps: [{ text: "s", evidence: [] }],
        anti_patterns: [],
        expected_outcome: "o",
      },
    },
    "skills.dedupe": {
      existing: { title: "a", steps: ["x"] },
      proposed: { title: "b", steps: ["y"] },
    },
  };
  const rendered = (p.render as (v: unknown) => string)(samples[p.id]);
  return createHash("sha256")
    .update(
      JSON.stringify([
        p.id,
        p.version,
        p.tier,
        p.maxTokens,
        p.system,
        rendered,
        z.toJSONSchema(p.output),
      ]),
    )
    .digest("hex");
}
