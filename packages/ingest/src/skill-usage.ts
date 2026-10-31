// Records that an agent used a skill. Shared by log_task (skills_used) and record_skill_use.
// Uses of a skill or version that doesn't exist are dropped, not stored.
import {
  and,
  eq,
  idFromKey,
  skillUsage,
  skillVersions,
  type SkillAdherence,
  type TenantTx,
} from "@mm/db";
import { enqueueLakeRecords, skillUsageRecord } from "@mm/lake";

export interface SkillUse {
  skillId: string;
  version: number;
  adherence: SkillAdherence;
}

export async function recordSkillUses(
  tx: TenantTx,
  tenantId: string,
  ctx: {
    memberId: string;
    agentId: string | null;
    sessionId: string | null;
    taskId: string | null;
    source: "mcp" | "bridge";
    usedAt: Date;
    /** Makes retries idempotent (e.g. the task id, or a request id). */
    key: string;
  },
  uses: SkillUse[],
): Promise<string[]> {
  const stored: string[] = [];
  for (const u of uses) {
    const [exists] = await tx
      .select({ v: skillVersions.version })
      .from(skillVersions)
      .where(and(eq(skillVersions.skillId, u.skillId), eq(skillVersions.version, u.version)));
    if (!exists) continue;
    const id = idFromKey([tenantId, "skill_use", ctx.key, u.skillId, String(u.version)]);
    const inserted = await tx
      .insert(skillUsage)
      .values({
        id,
        tenantId,
        skillId: u.skillId,
        version: u.version,
        taskId: ctx.taskId,
        sessionId: ctx.sessionId,
        memberId: ctx.memberId,
        agentIdentityId: ctx.agentId,
        adherence: u.adherence,
        usedAt: ctx.usedAt,
      })
      .onConflictDoNothing()
      .returning({ id: skillUsage.id });
    if (!inserted.length) continue;
    stored.push(id);
    await enqueueLakeRecords(tx, tenantId, [
      skillUsageRecord({
        id,
        tenantId,
        memberId: ctx.memberId,
        agentId: ctx.agentId,
        source: ctx.source,
        skillId: u.skillId,
        version: u.version,
        taskId: ctx.taskId,
        sessionId: ctx.sessionId,
        adherence: u.adherence,
        usedAt: ctx.usedAt,
        ingestedAt: new Date(),
      }),
    ]);
  }
  return stored;
}
