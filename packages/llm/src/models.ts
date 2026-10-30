export type ModelTier = "strong" | "fast";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Bedrock model ids per tier. "strong" handles extraction and verification; "fast" handles classification and labelling. */
export interface ModelConfig {
  strong: string;
  fast: string;
}

export function modelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  return {
    strong: env.MM_LLM_MODEL_STRONG || "anthropic.claude-sonnet-5-5",
    fast: env.MM_LLM_MODEL_FAST || "anthropic.claude-haiku-5-5",
  };
}

/**
 * USD per million tokens, from Anthropic list prices. Bedrock bills separately and its
 * prices can differ. Confirm against the AWS price list before using these numbers to
 * bill or quote customers. Unknown models get no cost estimate (null), not a guess.
 */
export const PRICE_PER_MTOK: Record<string, { input: number; output: number; cacheRead?: number }> =
  {
    "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
    "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  };

/** "us.anthropic.claude-sonnet-5-5" -> "claude-sonnet-5-5" */
export function baseModelId(model: string): string {
  const i = model.indexOf("claude-");
  return i >= 0 ? model.slice(i) : model;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export function estimateCostUsd(model: string, usage: TokenUsage): number | null {
  const price = PRICE_PER_MTOK[baseModelId(model)];
  if (!price) return null;
  const cacheRate = price.cacheRead ?? price.input;
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * cacheRate) /
    1_000_000
  );
}
