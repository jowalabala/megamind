// Input contracts for capture. Shared by the MCP tools, the REST API and the bridge.
import { ARTIFACT_KINDS } from "@mm/db/constants";
import { z } from "zod";

const datetime = () => z.iso.datetime({ offset: true });

export const EXTERNAL_REF_RE = /^[a-z][a-z0-9_]{0,30}:[a-z][a-z0-9_]{0,30}:\S{1,400}$/;
export const METRIC_KEY_RE = /^[a-z][a-z0-9_.]{0,99}$/;

export const sessionInput = z.object({
  id: z
    .string()
    .min(1)
    .max(200)
    .describe("Stable id of this agent run, e.g. the Claude Code session id."),
  repo: z.string().max(500).optional().describe("Git remote, e.g. github.com/acme/api."),
  branch: z.string().max(300).optional(),
  tool: z.string().max(100).optional().describe("Tool or app the agent works in, e.g. hubspot."),
  private: z.boolean().optional().describe("Hide this session from other agents."),
});

export const artifactInput = z
  .object({
    kind: z.enum(ARTIFACT_KINDS),
    content: z.string().max(100_000).optional(),
    uri: z.string().max(2_000).optional(),
  })
  .refine((a) => a.content !== undefined || a.uri !== undefined, {
    message: "An artifact needs content or a uri.",
  });

export const logTaskInput = z.object({
  title: z.string().trim().min(1).max(300).describe("One line: what the task was."),
  summary: z
    .string()
    .max(20_000)
    .default("")
    .describe("What was done and how. Personal data and secrets are removed before storage."),
  category_hint: z.string().max(100).optional().describe("Your best guess at the kind of work."),
  external_refs: z
    .array(z.string().regex(EXTERNAL_REF_RE, "Use system:type:id, e.g. github:pr:acme/api#123"))
    .max(50)
    .default([])
    .describe("Where the work lives, e.g. github:pr:acme/api#123 or hubspot:email:991."),
  artifacts: z.array(artifactInput).max(20).default([]),
  started_at: datetime().optional(),
  completed_at: datetime().optional(),
  idempotency_key: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Send the same key when retrying, so the task is stored once."),
  session: sessionInput.optional(),
});

export const reportOutcomeInput = z.object({
  task_id: z.uuid().describe("The task_id returned by log_task."),
  metric: z.string().regex(METRIC_KEY_RE, "lowercase, e.g. ci.first_pass or email.replied"),
  value: z.number().finite(),
  n: z
    .number()
    .int()
    .positive()
    .max(1_000_000_000)
    .default(1)
    .describe("Sample size, if the value is a rate."),
  observed_at: datetime().optional(),
  note: z.string().max(2_000).optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
});

export const ACTION_KINDS = ["tool_call", "edit", "command", "message", "outcome"] as const;

export const actionBatchInput = z.object({
  session: sessionInput,
  events: z
    .array(
      z.object({
        id: z.uuid().describe("Client-generated, so retries are stored once."),
        kind: z.enum(ACTION_KINDS),
        summary: z.string().max(4_000),
        resources: z.array(z.string().min(1).max(500)).max(100).default([]),
        occurred_at: datetime(),
        task_id: z.uuid().optional(),
      }),
    )
    .min(1)
    .max(100),
});

export type LogTaskInput = z.infer<typeof logTaskInput>;
export type ReportOutcomeInput = z.infer<typeof reportOutcomeInput>;
export type ActionBatchInput = z.infer<typeof actionBatchInput>;
export type SessionInput = z.infer<typeof sessionInput>;

export const announceIntentInput = z.object({
  description: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("One or two sentences: what you are about to work on, and why."),
  resources: z
    .array(z.string().min(1).max(600))
    .max(100)
    .default([])
    .describe(
      "What you expect to touch, as resource keys: git:<host/owner/repo>:<path>[#L<a>-<b>], hubspot:list:<id>, tag:<pack>:<name>.",
    ),
  session: sessionInput
    .optional()
    .describe("Your agent session. Required by the remote server; the local bridge fills it in."),
});
export type AnnounceIntentInput = z.infer<typeof announceIntentInput>;
