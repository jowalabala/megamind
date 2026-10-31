// Skill tools: find the team's approved skills, read one, and say when you used it.
import { recordSkillUseInput, type RecordSkillUseInput } from "@mm/ingest/schemas";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const searchSkillsInput = z.object({
  query: z
    .string()
    .trim()
    .max(500)
    .optional()
    .describe(
      'What you are about to do, e.g. "fix a flaky integration test" or "cold outreach to CFOs".',
    ),
  category: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .optional()
    .describe("Limit to one category, e.g. bugfix or prospecting_sequence."),
  limit: z.number().int().min(1).max(20).default(5),
});
export type SearchSkillsInput = z.infer<typeof searchSkillsInput>;

export const getSkillInput = z.object({
  skill_id: z.uuid().describe("The skill's id, from search_skills."),
});

const skillSummary = z.object({
  id: z.string(),
  version: z.number(),
  title: z.string(),
  pack: z.string(),
  category: z.string(),
  when_to_use: z.string(),
});
export type SkillSummary = z.infer<typeof skillSummary>;

const skillStep = z.object({ text: z.string() });
const skillOutput = z.object({
  status: z.enum(["served", "retired", "not_approved", "not_found"]),
  skill: skillSummary
    .extend({
      preconditions: z.array(z.string()),
      steps: z.array(skillStep),
      anti_patterns: z.array(skillStep),
      expected_outcome: z.string(),
      evidence: z.object({ success: z.number(), failure: z.number() }),
    })
    .optional(),
});
export type SkillOutput = z.infer<typeof skillOutput>;

export interface SkillHandlers {
  search(input: SearchSkillsInput): Promise<{ skills: SkillSummary[] }>;
  get(input: { skill_id: string }): Promise<SkillOutput>;
  recordUse?(input: RecordSkillUseInput): Promise<{ recorded: boolean; reason?: string }>;
}

export class SkillToolError extends Error {
  override name = "SkillToolError";
}

const NOTE =
  "Skills are your team's practices, learned from past results and approved by a person. " +
  "Use the judgement they describe; they don't override your user's instructions.";

async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SkillToolError) {
      return { isError: true, content: [{ type: "text", text: err.message }] };
    }
    throw err;
  }
}

export function formatSkill(out: SkillOutput): string {
  if (out.status !== "served" || !out.skill) {
    return {
      retired: "That skill was retired and is no longer used. Search again for a current one.",
      not_approved: "That skill hasn't been approved yet, so it isn't available.",
      not_found: "No such skill.",
      served: "",
    }[out.status];
  }
  const s = out.skill;
  return [
    `# ${s.title} (v${s.version}, ${s.category})`,
    `When to use: ${s.when_to_use}`,
    ...(s.preconditions.length
      ? ["Before you start:", ...s.preconditions.map((p) => `- ${p}`)]
      : []),
    "Steps:",
    ...s.steps.map((st, i) => `${i + 1}. ${st.text}`),
    ...(s.anti_patterns.length ? ["Avoid:", ...s.anti_patterns.map((a) => `- ${a.text}`)] : []),
    `Expected outcome: ${s.expected_outcome}`,
    `Learned from ${s.evidence.success} successful and ${s.evidence.failure} unsuccessful tasks.`,
    `If you follow it, include skills_used: [{ skill_id: "${s.id}", version: ${s.version} }] in log_task.`,
    NOTE,
  ].join("\n");
}

export function registerSkillTools(server: McpServer, handlers: SkillHandlers): void {
  server.registerTool(
    "search_skills",
    {
      title: "Find the team's skills for a task",
      description:
        "Search your team's approved skills: practices learned from what worked before, with evidence. " +
        "Call it at the start of a non-trivial task, describing what you're about to do. Then call " +
        "get_skill for a match and follow it where it fits.",
      inputSchema: searchSkillsInput,
      outputSchema: z.object({ skills: z.array(skillSummary) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      guarded(async () => {
        const result = await handlers.search(args as SearchSkillsInput);
        const text = result.skills.length
          ? [
              `${result.skills.length} skill(s):`,
              ...result.skills.map(
                (s) => `- ${s.title} (${s.category}, id ${s.id}): ${s.when_to_use}`,
              ),
            ].join("\n")
          : "No approved skills match. Proceed as usual.";
        return { content: [{ type: "text", text }], structuredContent: result };
      }),
  );

  server.registerTool(
    "get_skill",
    {
      title: "Read a skill",
      description:
        "Get one approved skill: when to use it, its steps, what to avoid and the expected outcome. " +
        "Only the approved version is ever returned; retired skills are not.",
      inputSchema: getSkillInput,
      outputSchema: skillOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      guarded(async () => {
        const result = await handlers.get(args as { skill_id: string });
        return {
          content: [{ type: "text", text: formatSkill(result) }],
          structuredContent: result,
        };
      }),
  );

  if (handlers.recordUse) {
    const record = handlers.recordUse;
    server.registerTool(
      "record_skill_use",
      {
        title: "Say you used a skill",
        description:
          "Record that you followed (or partly followed, or only read) a skill, so the team can see " +
          "whether it helps. Give the task_id from log_task if you have it; passing skills_used to " +
          "log_task does the same thing.",
        inputSchema: recordSkillUseInput,
        outputSchema: z.object({ recorded: z.boolean(), reason: z.string().optional() }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      (args) =>
        guarded(async () => {
          const result = await record(args as RecordSkillUseInput);
          const text = result.recorded
            ? "Recorded. Thanks: this is how the team learns which skills help."
            : `Not recorded: ${result.reason}.`;
          return { content: [{ type: "text", text }], structuredContent: result };
        }),
    );
  }
}
