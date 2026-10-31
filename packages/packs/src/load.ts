import { parse } from "yaml";
import { ENGINEERING_PACK, GENERIC_PACK, REVENUE_PACK } from "./builtin.ts";
import { packSchema, type Pack } from "./schema.ts";

export class PackError extends Error {
  override name = "PackError";
}

/** Parses and validates one pack. Throws PackError listing every problem. */
export function parsePack(yamlText: string): Pack {
  let raw: unknown;
  try {
    raw = parse(yamlText, { maxAliasCount: 50 });
  } catch (err) {
    throw new PackError(`Pack is not valid YAML: ${(err as Error).message}`);
  }
  const res = packSchema.safeParse(raw);
  if (!res.success) {
    const problems = res.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new PackError(`Invalid pack:\n- ${problems.join("\n- ")}`);
  }
  return res.data;
}

export function builtinPacks(): Pack[] {
  return [parsePack(ENGINEERING_PACK), parsePack(REVENUE_PACK), parsePack(GENERIC_PACK)];
}
