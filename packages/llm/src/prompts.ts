import type { z } from "zod";
import type { Effort, ModelTier } from "./models.ts";

/**
 * A versioned prompt. Bump `version` whenever system, render or output changes, so every
 * logged call and eval result can be tied to the exact prompt that produced it.
 */
export interface PromptDefinition<Vars, Out> {
  id: string;
  version: number;
  tier: ModelTier;
  system: string;
  render: (vars: Vars) => string;
  output: z.ZodType<Out>;
  maxTokens: number;
  effort?: Effort;
}

const PROMPT_ID_RE = /^[a-z][a-z0-9_.-]{1,63}$/;

export function definePrompt<Vars, Out>(
  def: PromptDefinition<Vars, Out>,
): PromptDefinition<Vars, Out> {
  if (!PROMPT_ID_RE.test(def.id)) throw new Error(`Invalid prompt id "${def.id}"`);
  if (!Number.isInteger(def.version) || def.version < 1) {
    throw new Error(`Prompt ${def.id}: version must be a positive integer`);
  }
  return Object.freeze({ ...def });
}

// The registry stores prompts of many shapes, so it types them loosely; callers get
// full types back through definePrompt's return value.
type AnyPrompt = PromptDefinition<never, unknown>;

export class PromptRegistry {
  #prompts = new Map<string, Map<number, AnyPrompt>>();

  register<P extends PromptDefinition<never, unknown>>(prompt: P): P {
    const versions = this.#prompts.get(prompt.id) ?? new Map<number, AnyPrompt>();
    if (versions.has(prompt.version)) {
      throw new Error(`Prompt ${prompt.id}@${prompt.version} is already registered`);
    }
    versions.set(prompt.version, prompt);
    this.#prompts.set(prompt.id, versions);
    return prompt;
  }

  /** The requested version, or the latest when no version is given. */
  get(id: string, version?: number): AnyPrompt {
    const versions = this.#prompts.get(id);
    if (!versions) throw new Error(`Unknown prompt ${id}`);
    const v = version ?? Math.max(...versions.keys());
    const prompt = versions.get(v);
    if (!prompt) throw new Error(`Unknown prompt ${id}@${v}`);
    return prompt;
  }

  list(): { id: string; versions: number[] }[] {
    return [...this.#prompts].map(([id, v]) => ({
      id,
      versions: [...v.keys()].sort((a, b) => a - b),
    }));
  }
}

/**
 * Wraps captured content (PRs, emails, agent messages) so the model treats it as data.
 * It is never a substitute for running models with no tools and validating their output.
 */
export function untrusted(source: string, text: string): string {
  const safeSource = source.replace(/[^a-zA-Z0-9_.:-]/g, "_");
  const safeText = text.replace(/<\/?untrusted_input/gi, (m) => m.replace("<", "&lt;"));
  return `<untrusted_input source="${safeSource}">\n${safeText}\n</untrusted_input>`;
}
