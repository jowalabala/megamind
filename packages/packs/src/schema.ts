// What a domain pack is. Packs are YAML; this validates them and compiles their rules.
import { CAPTURE_SOURCES } from "@mm/db/constants";
import { z } from "zod";

const ID = /^[a-z][a-z0-9_]{0,31}$/;
const CATEGORY_ID = /^[a-z][a-z0-9_]{0,63}$/;
const METRIC_ID = /^[a-z][a-z0-9_.]{0,99}$/;

/** A regex source from a pack: length-capped and must compile. */
const pattern = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (p) => {
      try {
        new RegExp(p, "i");
        return true;
      } catch {
        return false;
      }
    },
    { message: "not a valid regular expression" },
  );

/** Every key in a rule must match (AND); any rule matching picks the category (OR). */
export const ruleSchema = z
  .object({
    title: pattern.optional().describe("Regex on the title, case-insensitive."),
    labels_any: z.array(z.string().min(1).max(100)).max(50).optional(),
    branch: pattern.optional().describe("Regex on the source branch name."),
    files_all: z.array(pattern).max(20).optional().describe("Every changed file matches one."),
    files_any: z
      .array(pattern)
      .max(20)
      .optional()
      .describe("At least one changed file matches one."),
    author_bot: z.boolean().optional(),
  })
  .strict()
  .refine((r) => Object.keys(r).length > 0, { message: "a rule needs at least one condition" });
export type Rule = z.infer<typeof ruleSchema>;

const conditionSchema = z
  .object({
    metric: z.string().regex(METRIC_ID),
    op: z.enum(["eq", "ne", "lt", "lte", "gt", "gte"]),
    /** A fixed threshold... */
    value: z.number().optional(),
    /** ...or one relative to the team's own recent history. */
    baseline: z.enum(["p25", "p50", "p75", "mean"]).optional(),
  })
  .strict()
  .refine((c) => (c.value === undefined) !== (c.baseline === undefined), {
    message: "a condition needs exactly one of value or baseline",
  });
export type Condition = z.infer<typeof conditionSchema>;

/**
 * How the pack decides success. Verdicts: failure if any failure condition holds; success
 * if every success condition holds; inconclusive if one can't be evaluated (missing metric
 * or too little history for a baseline); neutral otherwise.
 */
export const judgeSchema = z
  .object({
    /** Bump on any change: judgments are stored per version and never rewritten. */
    version: z.number().int().positive(),
    /**
     * In a pack with several rule sets (`judges`), the categories this one judges. Leave it
     * out on one rule set to judge every category the others don't name.
     */
    categories: z.array(z.string().regex(CATEGORY_ID)).min(1).optional(),
    /** Metrics that must exist before a task is judged at all. */
    requires: z.array(z.string().regex(METRIC_ID)).min(1),
    skip_categories: z.array(z.string().regex(CATEGORY_ID)).default([]),
    failure_if_any: z.array(conditionSchema).default([]),
    success_if_all: z.array(conditionSchema).min(1),
    baseline: z
      .object({
        days: z.number().int().min(7).max(730).default(180),
        min_samples: z.number().int().min(5).max(1000).default(20),
      })
      .default({ days: 180, min_samples: 20 }),
  })
  .strict();
export type JudgeConfig = z.infer<typeof judgeSchema>;

export const packSchema = z
  .object({
    id: z.string().regex(ID),
    version: z.number().int().positive(),
    name: z.string().min(1).max(100),
    description: z.string().max(1000).default(""),
    applies_to: z
      .object({
        sources: z.array(z.enum(CAPTURE_SOURCES)).default([]),
        ref_systems: z.array(z.string().regex(ID)).default([]),
        /** Agent tasks run in a code repository (the session reported one). */
        code_sessions: z.boolean().default(false),
      })
      .default({ sources: [], ref_systems: [], code_sessions: false }),
    categories: z
      .array(
        z.object({
          id: z.string().regex(CATEGORY_ID),
          name: z.string().min(1).max(100),
          description: z.string().min(1).max(500),
          rules: z.array(ruleSchema).max(50).default([]),
        }),
      )
      .min(1)
      .max(100),
    /** Category used when nothing else decides. Must be one of the categories. */
    fallback: z.string().regex(CATEGORY_ID),
    features: z
      .array(z.object({ id: z.string().regex(CATEGORY_ID), description: z.string().max(300) }))
      .default([]),
    metrics: z
      .array(
        z.object({
          id: z.string().regex(METRIC_ID),
          description: z.string().max(300),
          unit: z.enum(["ratio", "count", "hours", "boolean"]),
          better: z.enum(["higher", "lower"]),
          /** Days after the work completes before this metric is final. */
          window_days: z.number().int().min(0).max(365).optional(),
        }),
      )
      .default([]),
    judge: judgeSchema.optional(),
    /** Several rule sets, one per group of categories, when their metrics differ. */
    judges: z.array(judgeSchema).min(1).max(20).optional(),
  })
  .superRefine((p, ctx) => {
    if (p.judge && p.judges) {
      ctx.addIssue({ code: "custom", message: "use judge or judges, not both", path: ["judges"] });
    }
    if (p.judge?.categories) {
      ctx.addIssue({
        code: "custom",
        message: "categories belongs on rule sets inside judges",
        path: ["judge", "categories"],
      });
    }
    if (p.judges) {
      if (new Set(p.judges.map((j) => j.version)).size > 1) {
        ctx.addIssue({
          code: "custom",
          message: "every rule set in judges needs the same version",
          path: ["judges"],
        });
      }
      const seen = new Set<string>();
      let catchAll = 0;
      for (const j of p.judges) {
        if (!j.categories) catchAll++;
        for (const c of j.categories ?? []) {
          if (seen.has(c)) {
            ctx.addIssue({
              code: "custom",
              message: `category ${c} is in two rule sets`,
              path: ["judges"],
            });
          }
          seen.add(c);
          if (!p.categories.some((x) => x.id === c)) {
            ctx.addIssue({
              code: "custom",
              message: `judges: ${c} is not a category`,
              path: ["judges"],
            });
          }
        }
      }
      if (catchAll > 1) {
        ctx.addIssue({
          code: "custom",
          message: "only one rule set may leave out categories",
          path: ["judges"],
        });
      }
    }
    const ids = p.categories.map((c) => c.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: "custom",
        message: "category ids must be unique",
        path: ["categories"],
      });
    }
    if (!ids.includes(p.fallback)) {
      ctx.addIssue({
        code: "custom",
        message: "fallback must be a category id",
        path: ["fallback"],
      });
    }
  });
export type Pack = z.infer<typeof packSchema>;

/** A pack's rule sets: `judges`, or its single `judge`, or none. */
export function packJudges(pack: Pack): JudgeConfig[] {
  return pack.judges ?? (pack.judge ? [pack.judge] : []);
}

/** The ruleset version of a pack's judgments, or null when it judges nothing. */
export function judgeVersion(pack: Pack): number | null {
  return packJudges(pack)[0]?.version ?? null;
}

/** The rule set that judges a category: the one naming it, else the catch-all. */
export function judgeFor(pack: Pack, category: string | null): JudgeConfig | null {
  const all = packJudges(pack);
  return (
    (category ? all.find((j) => j.categories?.includes(category)) : undefined) ??
    all.find((j) => !j.categories) ??
    null
  );
}
