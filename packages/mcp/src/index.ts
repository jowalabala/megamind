// MCP tool definitions shared by the remote MCP server and the local bridge.
// Descriptions are written for the agent reading them: when to call, what to send.
import {
  logTaskInput,
  reportOutcomeInput,
  type LogTaskInput,
  type ReportOutcomeInput,
} from "@mm/ingest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const SERVER_INFO = { name: "master-mind", version: "0.2.0" };

export const SERVER_INSTRUCTIONS = `Master Mind is your team's shared memory of what work was done and what worked.
Call log_task when you finish a meaningful unit of work (a fix, a feature, a campaign email, an analysis), and report_outcome when you learn how it went.
Personal data and secrets are removed before anything is stored. If the member has opted out, nothing is stored and the tools say so.`;

export interface CaptureResult {
  captured: boolean;
  id?: string;
  reason?: string;
}

export interface CaptureHandlers {
  logTask(input: LogTaskInput): Promise<CaptureResult>;
  reportOutcome(input: ReportOutcomeInput): Promise<CaptureResult>;
}

/** A tool failure the agent should see and can act on (e.g. a missing scope). */
export class ToolUserError extends Error {
  override name = "ToolUserError";
}

function toResult(result: CaptureResult, idName: string): CallToolResult {
  const structured = result.captured
    ? { captured: true, [idName]: result.id }
    : { captured: false, reason: result.reason };
  const text = result.captured
    ? `Stored. ${idName}: ${result.id}`
    : `Not stored: ${result.reason === "capture_opt_out" ? "this member has opted out of capture" : result.reason}.`;
  return { content: [{ type: "text", text }], structuredContent: structured };
}

async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ToolUserError) {
      return { isError: true, content: [{ type: "text", text: err.message }] };
    }
    throw err;
  }
}

export function registerCaptureTools(server: McpServer, handlers: CaptureHandlers): void {
  server.registerTool(
    "log_task",
    {
      title: "Log a finished task",
      description:
        "Record a unit of work you just finished, so the team can learn which practices lead to good outcomes. " +
        "Call it once per task, at the end. Include external_refs (e.g. github:pr:acme/api#123) whenever the work " +
        "lives in another system: that is how outcomes are matched to it later. Returns a task_id for report_outcome.",
      inputSchema: logTaskInput,
      outputSchema: z.object({
        captured: z.boolean(),
        task_id: z.string().optional(),
        reason: z.string().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    (args) =>
      guarded(async () => toResult(await handlers.logTask(args as LogTaskInput), "task_id")),
  );

  server.registerTool(
    "report_outcome",
    {
      title: "Report how a task turned out",
      description:
        "Record a measured result for a task you logged earlier, e.g. ci.first_pass = 1, email.replied = 0.12 with n = 400, " +
        "or deal.stage_advanced = 1. Use lowercase dotted metric names. Report facts you observed, not guesses.",
      inputSchema: reportOutcomeInput,
      outputSchema: z.object({
        captured: z.boolean(),
        observation_id: z.string().optional(),
        reason: z.string().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    (args) =>
      guarded(async () =>
        toResult(await handlers.reportOutcome(args as ReportOutcomeInput), "observation_id"),
      ),
  );
}
