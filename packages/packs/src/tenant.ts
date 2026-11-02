// Packs per tenant: the built-in packs, with a tenant's own edited version of a pack in place
// of the built-in one. In the MVP admins edit only the generic pack (their own categories,
// metrics and success rules); the engineering and revenue packs stay as shipped.
import { packRepo, type MasterMindDb, type TenantPack } from "@mm/db";
import { stringify } from "yaml";
import { builtinPacks, PackError, parsePack } from "./load.ts";
import { packJudges, type Pack } from "./schema.ts";

export const TENANT_EDITABLE_PACKS = ["generic"] as const;
/** Sources a tenant pack may claim: never a connector that has its own pack. */
const OPEN_SOURCES = new Set(["mcp", "bridge", "csv", "ui"]);
const CONNECTOR_SYSTEMS = new Set(["github", "hubspot"]);

/**
 * Validates an admin's pack YAML for storage as `version`. The pack and judge versions are
 * set from the stored version, so every save changes the ruleset version and judgments made
 * under older rules are never rewritten.
 */
export function parseTenantPack(yamlText: string, version: number): { pack: Pack; yaml: string } {
  const pack = parsePack(yamlText);
  const problems: string[] = [];
  if (!(TENANT_EDITABLE_PACKS as readonly string[]).includes(pack.id)) {
    problems.push(`only these packs can be edited: ${TENANT_EDITABLE_PACKS.join(", ")}`);
  }
  for (const s of pack.applies_to.sources) {
    if (!OPEN_SOURCES.has(s)) problems.push(`applies_to.sources: ${s} has its own pack`);
  }
  for (const s of pack.applies_to.ref_systems) {
    if (CONNECTOR_SYSTEMS.has(s)) problems.push(`applies_to.ref_systems: ${s} has its own pack`);
  }
  if (pack.applies_to.code_sessions) {
    problems.push("applies_to.code_sessions: code sessions belong to the engineering pack");
  }
  const metricIds = new Set(pack.metrics.map((m) => m.id));
  const categoryIds = new Set(pack.categories.map((c) => c.id));
  for (const j of packJudges(pack)) {
    for (const c of [...j.success_if_all, ...j.failure_if_any]) {
      if (!metricIds.has(c.metric)) {
        problems.push(`judge: ${c.metric} is not one of the pack's metrics`);
      }
    }
    for (const m of j.requires) {
      if (!metricIds.has(m)) problems.push(`judge.requires: ${m} is not one of the pack's metrics`);
    }
    for (const c of j.skip_categories) {
      if (!categoryIds.has(c)) problems.push(`judge.skip_categories: ${c} is not a category`);
    }
  }
  if (problems.length) throw new PackError(`Invalid pack:\n- ${problems.join("\n- ")}`);

  const normalized: Pack = {
    ...pack,
    version,
    ...(pack.judge ? { judge: { ...pack.judge, version } } : {}),
    ...(pack.judges ? { judges: pack.judges.map((j) => ({ ...j, version })) } : {}),
  };
  return { pack: normalized, yaml: stringify(normalized, { lineWidth: 0 }) };
}

/** Plain-object form of a pack, for editors that work on structure rather than YAML. */
export function packToYaml(pack: Pack): string {
  return stringify(pack, { lineWidth: 0 });
}

export interface TenantPackSet {
  /** What categorizes and judges new work. */
  current: Pack[];
  /** Current packs plus every older stored version, for replaying old judgments. */
  all: Pack[];
}

/** Either a fixed list (tests, tools) or a per-tenant loader. */
export type PackSource = Pack[] | ((tenantId: string) => Promise<TenantPackSet>);

export async function resolvePacks(source: PackSource, tenantId: string): Promise<TenantPackSet> {
  return Array.isArray(source) ? { current: source, all: source } : source(tenantId);
}

function combine(stored: TenantPack[], latest: TenantPack[]): TenantPackSet {
  const builtins = builtinPacks();
  const parsed = (p: TenantPack) => {
    try {
      return parseTenantPack(p.yaml, p.version).pack;
    } catch {
      return null; // a version stored by an older release that no longer validates
    }
  };
  const overrides = new Map<string, Pack>();
  for (const p of latest) {
    const pack = parsed(p);
    if (pack) overrides.set(pack.id, pack);
  }
  const current = builtins.map((b) => overrides.get(b.id) ?? b);
  const older = stored.map(parsed).filter((p): p is Pack => !!p);
  // Built-ins stay in `all`: tasks judged before the first edit were judged by them.
  return { current, all: [...current, ...builtins, ...older] };
}

/** Loads each tenant's packs from the database, cached briefly. */
export function tenantPackLoader(
  db: MasterMindDb,
  options: { ttlMs?: number } = {},
): (tenantId: string) => Promise<TenantPackSet> {
  const ttl = options.ttlMs ?? 30_000;
  const cache = new Map<string, { at: number; set: TenantPackSet }>();
  return async (tenantId) => {
    const hit = cache.get(tenantId);
    if (hit && Date.now() - hit.at < ttl) return hit.set;
    const set = await db.withTenant(tenantId, async (tx) => {
      const latest = await packRepo.latestTenantPacks(tx);
      const stored = (
        await Promise.all(latest.map((p) => packRepo.packVersions(tx, p.packId)))
      ).flat();
      return combine(stored, latest);
    });
    cache.set(tenantId, { at: Date.now(), set });
    return set;
  };
}

/** The pack an admin edits: their latest version, else the built-in one. */
export async function editablePack(
  db: MasterMindDb,
  tenantId: string,
  packId: (typeof TENANT_EDITABLE_PACKS)[number],
): Promise<{ pack: Pack; version: number }> {
  const latest = await db.withTenant(tenantId, (tx) => packRepo.latestTenantPacks(tx));
  const mine = latest.find((p) => p.packId === packId);
  if (mine) return { pack: parseTenantPack(mine.yaml, mine.version).pack, version: mine.version };
  return { pack: builtinPacks().find((p) => p.id === packId)!, version: 0 };
}
