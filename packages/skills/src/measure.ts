// Measurement: does following a skill help? For each served skill, compares judged work in its
// category over a recent window: work that followed the served version vs work that didn't.
//
// A unit of work is a judged task (a PR, a sequence, or an agent task judged directly). It
// counts as "used" when it, or an agent task attributed to it with enough confidence, recorded
// use of the skill (followed or partially followed; only consulting it doesn't count).
//
// The interval is Agresti-Caffo's for a difference of proportions (one success and one failure
// added to each side), which stays sensible with small or all-or-nothing samples. When the
// whole interval is below zero, the skill is flagged and goes back to its reviewers. It stays
// served until a person decides: flags never retire anything on their own.
import { appendAuditEvent } from "@mm/audit";
import {
  ATTRIBUTION_MIN_CONFIDENCE,
  desc,
  eq,
  notificationRepo,
  skillMeasurements,
  skills,
  sql,
  type MasterMindDb,
  type MeasurementStatus,
  type TenantTx,
} from "@mm/db";

export const MEASURE = {
  windowDays: 90,
  /** Fewer judged tasks than this on either side: too little to say anything. */
  minPerSide: 10,
};

export interface Lift {
  usedN: number;
  usedSuccess: number;
  baseN: number;
  baseSuccess: number;
  lift: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  status: MeasurementStatus;
}

const round = (x: number) => Math.round(x * 10_000) / 10_000;

/** Pure: success counts on each side to a lift, its 95% interval and a status. */
export function liftOf(
  used: { n: number; success: number },
  base: { n: number; success: number },
  minPerSide = MEASURE.minPerSide,
): Lift {
  const out = {
    usedN: used.n,
    usedSuccess: used.success,
    baseN: base.n,
    baseSuccess: base.success,
  };
  if (used.n < minPerSide || base.n < minPerSide) {
    return { ...out, lift: null, ciLow: null, ciHigh: null, status: "insufficient" };
  }
  const p1 = (used.success + 1) / (used.n + 2);
  const p0 = (base.success + 1) / (base.n + 2);
  const se = Math.sqrt((p1 * (1 - p1)) / (used.n + 2) + (p0 * (1 - p0)) / (base.n + 2));
  const lift = used.success / used.n - base.success / base.n;
  const centre = p1 - p0;
  const ciLow = centre - 1.96 * se;
  const ciHigh = centre + 1.96 * se;
  const status: MeasurementStatus = ciLow > 0 ? "improves" : ciHigh < 0 ? "degrades" : "no_effect";
  return { ...out, lift: round(lift), ciLow: round(ciLow), ciHigh: round(ciHigh), status };
}

/** Judged work in the skill's category, split by whether it followed the served version. */
async function counts(
  tx: TenantTx,
  skill: { id: string; pack: string; category: string; approvedVersion: number },
  now: Date,
  windowDays: number,
) {
  const from = new Date(now.getTime() - windowDays * 86_400_000);
  const res = await tx.execute<{ used: boolean; n: number; success: number }>(sql`
    WITH judged AS (
      SELECT DISTINCT ON (j.task_id) j.task_id, j.verdict
        FROM judgments j JOIN tasks t ON t.tenant_id = j.tenant_id AND t.id = j.task_id
       WHERE j.pack = ${skill.pack} AND j.category = ${skill.category}
         AND j.verdict IN ('success', 'failure', 'neutral')
         AND t.completed_at >= ${from.toISOString()} AND t.completed_at < ${now.toISOString()}
       ORDER BY j.task_id, j.ruleset_version DESC
    ), uses AS (
      SELECT task_id FROM skill_usage
       WHERE skill_id = ${skill.id} AND version = ${skill.approvedVersion}
         AND adherence <> 'consulted' AND task_id IS NOT NULL
    ), used AS (
      SELECT task_id FROM uses
      UNION
      SELECT a.target_task_id FROM uses u
        JOIN task_attributions a ON a.task_id = u.task_id
       WHERE a.confidence >= ${ATTRIBUTION_MIN_CONFIDENCE}
    )
    SELECT (j.task_id IN (SELECT task_id FROM used)) AS used,
           count(*)::int AS n,
           count(*) FILTER (WHERE j.verdict = 'success')::int AS success
      FROM judged j GROUP BY 1`);
  const side = (used: boolean) => {
    const r = res.rows.find((x) => x.used === used);
    return { n: Number(r?.n ?? 0), success: Number(r?.success ?? 0) };
  };
  return { used: side(true), base: side(false) };
}

export interface MeasureDeps {
  db: MasterMindDb;
  now?: () => Date;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** Measures every served skill. Returns the skills flagged by this run. */
export async function measureSkills(
  deps: MeasureDeps,
  tenantId: string,
  options: { windowDays?: number; minPerSide?: number } = {},
): Promise<{ measured: number; flagged: string[] }> {
  const now = deps.now?.() ?? new Date();
  const windowDays = options.windowDays ?? MEASURE.windowDays;
  return deps.db.withTenant(tenantId, async (tx) => {
    const served = await tx
      .select()
      .from(skills)
      .where(sql`${skills.status} <> 'retired' AND ${skills.approvedVersion} IS NOT NULL`);
    const flagged: string[] = [];
    for (const s of served) {
      const c = await counts(tx, { ...s, approvedVersion: s.approvedVersion! }, now, windowDays);
      const result = liftOf(c.used, c.base, options.minPerSide);
      const [last] = await tx
        .select()
        .from(skillMeasurements)
        .where(eq(skillMeasurements.skillId, s.id))
        .orderBy(desc(skillMeasurements.measuredAt))
        .limit(1);
      const unchanged =
        last &&
        last.version === s.approvedVersion &&
        last.usedN === result.usedN &&
        last.usedSuccess === result.usedSuccess &&
        last.baseN === result.baseN &&
        last.baseSuccess === result.baseSuccess;
      if (!unchanged) {
        await tx.insert(skillMeasurements).values({
          tenantId,
          skillId: s.id,
          version: s.approvedVersion,
          windowDays,
          ...result,
          measuredAt: now,
        });
      }
      if (result.status === "degrades" && !s.flaggedAt) {
        const pct = (x: number, n: number) => `${Math.round((100 * x) / n)}%`;
        const reason = `Work that followed v${s.approvedVersion} succeeded ${pct(result.usedSuccess, result.usedN)} of the time (${result.usedN} tasks), against ${pct(result.baseSuccess, result.baseN)} without it (${result.baseN} tasks).`;
        await tx
          .update(skills)
          .set({ flaggedAt: now, flagReason: reason })
          .where(eq(skills.id, s.id));
        await appendAuditEvent(tx, tenantId, {
          actorType: "system",
          actorId: null,
          action: "skill.flagged",
          targetType: "skill",
          targetId: s.id,
          payload: { version: s.approvedVersion, lift: result.lift, ci_high: result.ciHigh },
        });
        const reviewers = await notificationRepo.reviewersOf(tx, s.pack, s.category);
        await notificationRepo.enqueueMany(tx, tenantId, reviewers, "skill_flagged", {
          skill_id: s.id,
          version: s.approvedVersion,
          title: s.title,
          reason,
        });
        flagged.push(s.id);
      }
    }
    if (flagged.length) deps.log?.("skills.flagged", { tenantId, skills: flagged.length });
    return { measured: served.length, flagged };
  });
}

export async function latestMeasurements(tx: TenantTx, skillId: string, limit = 10) {
  return tx
    .select()
    .from(skillMeasurements)
    .where(eq(skillMeasurements.skillId, skillId))
    .orderBy(desc(skillMeasurements.measuredAt))
    .limit(limit);
}
