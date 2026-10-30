import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { Effort, TokenUsage } from "./models.ts";

export interface LlmRequest<T> {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  effort?: Effort;
  output: z.ZodType<T>;
}

export interface LlmResponse<T> {
  stopReason: string | null;
  /** Null when the model's output could not be parsed against the schema. */
  parsed: T | null;
  usage: TokenUsage;
}

/** The one seam between our code and the model provider; tests swap in a fake. */
export interface LlmTransport {
  send<T>(req: LlmRequest<T>): Promise<LlmResponse<T>>;
}

/**
 * Claude on Amazon Bedrock through the Messages API ("Mantle") endpoint. Credentials come
 * from the standard AWS chain (task role on ECS, a profile locally). Structured output uses
 * output_config.format, because forced tool_choice is rejected on the current models.
 */
export function bedrockTransport(options: { awsRegion?: string } = {}): LlmTransport {
  const client = new AnthropicBedrockMantle({ awsRegion: options.awsRegion });
  return {
    async send<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
      const msg = await client.messages.parse({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        output_config: {
          format: zodOutputFormat(req.output),
          ...(req.effort ? { effort: req.effort } : {}),
        },
      });
      return {
        stopReason: msg.stop_reason,
        parsed: (msg.parsed_output as T | null) ?? null,
        usage: {
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens,
          cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
        },
      };
    },
  };
}
