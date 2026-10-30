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
        }),
      )
      .default([]),
  })
  .superRefine((p, ctx) => {
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
