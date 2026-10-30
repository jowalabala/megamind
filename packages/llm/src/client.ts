import { createHash } from "node:crypto";
import { llmCalls, type MasterMindDb } from "@mm/db";
import { estimateCostUsd, type ModelConfig } from "./models.ts";
import type { PromptDefinition } from "./prompts.ts";
import type { LlmTransport } from "./transport.ts";

export type LlmCallStatus = "ok" | "error" | "refusal" | "truncated" | "invalid_output";

/** One logged call. Holds no prompt or output text, only a hash of the input. */
export interface LlmCallRecord {
  tenantId: string;
  stage: string;
  promptId: string;
  promptVersion: number;
  model: string;
  status: LlmCallStatus;
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  latencyMs: number;
  costUsd: number | null;
  inputHash: string;
}

export type CallLogger = (record: LlmCallRecord) => Promise<void>;

export class LlmError extends Error {
  override name = "LlmError";
  constructor(
    readonly status: Exclude<LlmCallStatus, "ok">,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface CallContext {
  tenantId: string;
  /** Pipeline stage, e.g. "categorize", "skill.extract". */
  stage: string;
}

export interface Llm {
  run<Vars, Out>(prompt: PromptDefinition<Vars, Out>, vars: Vars, ctx: CallContext): Promise<Out>;
}

export function createLlm(deps: {
  transport: LlmTransport;
  models: ModelConfig;
  log: CallLogger;
  clock?: () => number;
}): Llm {
  const clock = deps.clock ?? (() => performance.now());

  return {
    async run<Vars, Out>(
      prompt: PromptDefinition<Vars, Out>,
      vars: Vars,
      ctx: CallContext,
    ): Promise<Out> {
      const model = deps.models[prompt.tier];
      const user = prompt.render(vars);
      const inputHash = createHash("sha256")
        .update(JSON.stringify([prompt.id, prompt.version, model, prompt.system, user]))
        .digest("hex");
      const base = {
        tenantId: ctx.tenantId,
        stage: ctx.stage,
        promptId: prompt.id,
        promptVersion: prompt.version,
        model,
        inputHash,
      };

      const started = clock();
      let response;
      try {
        response = await deps.transport.send({
          model,
          system: prompt.system,
          user,
          maxTokens: prompt.maxTokens,
          effort: prompt.effort,
          output: prompt.output,
        });
      } catch (err) {
        const code =
          (err as { status?: number }).status?.toString() ?? (err as Error).name ?? "unknown";
        await safeLog(deps.log, {
          ...base,
          status: "error",
          errorCode: code,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          latencyMs: Math.round(clock() - started),
          costUsd: null,
        });
        throw new LlmError("error", `LLM call ${prompt.id}@${prompt.version} failed`, {
          cause: err,
        });
      }

      let status: LlmCallStatus = "ok";
      let output: Out | null = null;
      if (response.stopReason === "refusal") status = "refusal";
      else if (response.stopReason === "max_tokens") status = "truncated";
      else {
        // Validate again ourselves rather than trusting the SDK's parse.
        const checked = prompt.output.safeParse(response.parsed);
        if (response.parsed === null || !checked.success) status = "invalid_output";
        else output = checked.data;
      }

      await safeLog(deps.log, {
        ...base,
        status,
        errorCode: status === "ok" ? null : (response.stopReason ?? status),
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheReadTokens: response.usage.cacheReadTokens,
        latencyMs: Math.round(clock() - started),
        costUsd: estimateCostUsd(model, response.usage),
      });

      if (status !== "ok") {
        throw new LlmError(status, `LLM call ${prompt.id}@${prompt.version} ended with ${status}`);
      }
      return output as Out;
    },
  };
}

async function safeLog(log: CallLogger, record: LlmCallRecord) {
  try {
    await log(record);
  } catch (err) {
    // A logging failure must not fail the pipeline step, but it must be visible.
    console.error("llm call log failed", { promptId: record.promptId, err });
  }
}

/** Writes call records to the tenant's llm_calls table. */
export function dbCallLogger(db: MasterMindDb): CallLogger {
  return (r) =>
    db.withTenant(r.tenantId, async (tx) => {
      await tx.insert(llmCalls).values({
        ...r,
        costUsd: r.costUsd === null ? null : r.costUsd.toFixed(6),
      });
    });
}
