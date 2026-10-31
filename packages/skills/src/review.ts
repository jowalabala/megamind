// Human review of skills: who may approve, what each action does, and the library views.
//
// approve   the current version becomes the one agents receive (approved_version)
// reject    the current version isn't used; a skill with nothing approved yet is retired
// retire    no version is served
// restore   a retired skill serves its last approved version again
// rollback  serve an earlier version instead
//
// Admins review everything; category owners review their categories. Every action is audited.
import { appendAuditEvent } from "@mm/audit";
import {
  and,
  categoryOwners,
  eq,
  members,
  skillReviews,
  skills,
  skillVersions,
  sql,
  type ReviewAction,
  type TenantTx,
} from "@mm/db";

export class ReviewError extends Error {
  override name = "ReviewError";
}

export async function canReview(
  tx: TenantTx,
  memberId: string,
  skill: { pack: string; category: string },
): Promise<boolean> {
  const [m] = await tx.select({ role: members.role }).from(members).where(eq(members.id, memberId));
  if (!m) return false;
  if (m.role === "admin") return true;
  const [owner] = await tx
    .select()
    .from(categoryOwners)
    .where(
      and(
        eq(categoryOwners.memberId, memberId),
        eq(categoryOwners.pack, skill.pack),
        eq(categoryOwners.category, skill.category),
      ),
    );
  return Boolean(owner);
}

export async function reviewSkill(
  tx: TenantTx,
  tenantId: string,
  input: {
    skillId: string;
    memberId: string;
    action: ReviewAction;
    version?: number;
    note?: string;
  },
) {
  const [skill] = await tx.select().from(skills).where(eq(skills.id, input.skillId)).for("update");
  if (!skill) throw new ReviewError("No such skill.");
  if (!(await canReview(tx, input.memberId, skill))) {
    throw new ReviewError("Only admins and this category's owners can review its skills.");
  }
  let version = skill.currentVersion;
  const set: Partial<typeof skills.$inferInsert> = { updatedAt: new Date() };
  switch (input.action) {
    case "approve":
      if (skill.status === "retired")
        throw new ReviewError("Restore the skill before approving a version.");
      set.status = "approved";
      set.approvedVersion = version;
      break;
    case "reject":
      if (skill.status !== "in_review")
        throw new ReviewError("Only a version in review can be rejected.");
      set.status = skill.approvedVersion ? "approved" : "retired";
      break;
    case "retire":
      set.status = "retired";
      break;
    case "restore":
      if (skill.status !== "retired")
        throw new ReviewError("Only a retired skill can be restored.");
      set.status = skill.approvedVersion ? "approved" : "in_review";
      break;
    case "rollback": {
      const to = input.version;
      if (!to || to === skill.approvedVersion) {
        throw new ReviewError("Pick a version other than the one already served.");
      }
      const [exists] = await tx
        .select({ v: skillVersions.version })
        .from(skillVersions)
        .where(and(eq(skillVersions.skillId, skill.id), eq(skillVersions.version, to)));
      if (!exists) throw new ReviewError(`Version ${to} doesn't exist.`);
      version = to;
      set.status = "approved";
      set.approvedVersion = to;
      break;
    }
  }
  await tx.update(skills).set(set).where(eq(skills.id, skill.id));
  await tx.insert(skillReviews).values({
    tenantId,
    skillId: skill.id,
    version,
    action: input.action,
    memberId: input.memberId,
    note: input.note?.slice(0, 2000) ?? null,
  });
  await appendAuditEvent(tx, tenantId, {
    actorType: "member",
    actorId: input.memberId,
    action: `skill.${input.action}`,
    targetType: "skill",
    targetId: skill.id,
    payload: { version },
  });
  return {
    status: set.status ?? skill.status,
    approvedVersion: set.approvedVersion ?? skill.approvedVersion,
  };
}

export type SkillListItem = {
  id: string;
  title: string;
  pack: string;
  category: string;
  status: string;
  current_version: number;
  approved_version: number | null;
  updated_at: string;
  rank: number;
};

/** The library: keyword search over each skill's latest version (title and body). */
export async function searchSkills(
  tx: TenantTx,
  q: { text?: string; status?: string; category?: string; limit?: number },
): Promise<SkillListItem[]> {
  const text = q.text?.trim() || null;
  const tsq = text ? sql`websearch_to_tsquery('simple', ${text})` : sql`NULL::tsquery`;
  const res = await tx.execute<Omit<SkillListItem, "updated_at"> & { updated_at: Date }>(sql`
    SELECT s.id, s.title, s.pack, s.category, s.status, s.current_version, s.approved_version, s.updated_at,
           ${text ? sql`ts_rank(v.search, ${tsq}) + CASE WHEN s.title ILIKE ${`%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`} THEN 1 ELSE 0 END` : sql`0`}::float8 AS rank
      FROM skills s
      JOIN skill_versions v ON v.skill_id = s.id AND v.version = s.current_version
     WHERE true
       ${text ? sql`AND (v.search @@ ${tsq} OR s.title ILIKE ${`%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`})` : sql``}
       ${q.status ? sql`AND s.status = ${q.status}` : sql``}
       ${q.category ? sql`AND s.category = ${q.category}` : sql``}
     ORDER BY rank DESC, s.updated_at DESC
     LIMIT ${Math.min(q.limit ?? 50, 200)}`);
  return res.rows.map((r) => ({
    ...r,
    updated_at: new Date(r.updated_at).toISOString(),
    rank: Number(r.rank),
  }));
}

/** Skills waiting for this member's review. */
export async function reviewQueue(tx: TenantTx, memberId: string) {
  const [m] = await tx.select({ role: members.role }).from(members).where(eq(members.id, memberId));
  const all = await searchSkills(tx, { status: "in_review", limit: 200 });
  if (m?.role === "admin") return all;
  const owned = await tx.select().from(categoryOwners).where(eq(categoryOwners.memberId, memberId));
  return all.filter((s) => owned.some((o) => o.pack === s.pack && o.category === s.category));
}

/** One skill with every version, its review history, and the work its evidence points to. */
export async function getSkill(tx: TenantTx, id: string) {
  const [skill] = await tx.select().from(skills).where(eq(skills.id, id));
  if (!skill) return null;
  const versions = await tx
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.skillId, id))
    .orderBy(sql`${skillVersions.version} DESC`);
  const reviews = await tx
    .select()
    .from(skillReviews)
    .where(eq(skillReviews.skillId, id))
    .orderBy(sql`${skillReviews.createdAt} DESC`);
  const current = versions[0];
  const ids = [
    ...new Set([...(current?.evidence.success ?? []), ...(current?.evidence.failure ?? [])]),
  ];
  const evidence = ids.length
    ? (
        await tx.execute<{
          id: string;
          title: string;
          refs: string[] | null;
          category: string | null;
        }>(sql`
          SELECT t.id, t.title_redacted AS title, t.category,
                 (SELECT array_agg(r.ref ORDER BY r.ref) FROM external_refs r WHERE r.task_id = t.id) AS refs
            FROM tasks t WHERE t.id = ANY(${sql.raw(`ARRAY[${ids.map((x) => `'${x.replace(/[^0-9a-f-]/g, "")}'`).join(",")}]::uuid[]`)})`)
      ).rows
    : [];
  return { skill, versions, reviews, evidence };
}

export async function setCategoryOwner(
  tx: TenantTx,
  tenantId: string,
  input: { adminId: string; memberId: string; pack: string; category: string; owner: boolean },
) {
  const [admin] = await tx
    .select({ role: members.role })
    .from(members)
    .where(eq(members.id, input.adminId));
  if (admin?.role !== "admin") throw new ReviewError("Only admins can assign category owners.");
  if (input.owner) {
    await tx
      .insert(categoryOwners)
      .values({ tenantId, memberId: input.memberId, pack: input.pack, category: input.category })
      .onConflictDoNothing();
  } else {
    await tx
      .delete(categoryOwners)
      .where(
        and(
          eq(categoryOwners.memberId, input.memberId),
          eq(categoryOwners.pack, input.pack),
          eq(categoryOwners.category, input.category),
        ),
      );
  }
  await appendAuditEvent(tx, tenantId, {
    actorType: "member",
    actorId: input.adminId,
    action: input.owner ? "category_owner.added" : "category_owner.removed",
    targetType: "member",
    targetId: input.memberId,
    payload: { pack: input.pack, category: input.category },
  });
}
