// Delivery: what agents receive. Only a skill's approved version is ever served, and a retired
// skill is never served. A newer version waiting for review doesn't change what agents get.
import {
  and,
  eq,
  skillSubscriptions,
  skills,
  skillVersions,
  sql,
  type SkillDraftBody,
  type TenantTx,
} from "@mm/db";

export type ServedSkillSummary = {
  id: string;
  version: number;
  title: string;
  pack: string;
  category: string;
  when_to_use: string;
};

export type ServedSkill = ServedSkillSummary & {
  body: SkillDraftBody;
  evidence: { success: number; failure: number };
  approved_at: string | null;
};

export type SkillLookup =
  | { status: "served"; skill: ServedSkill }
  | { status: "retired" | "not_approved" | "not_found"; title?: string };

/** Search over approved versions only. */
export async function searchServedSkills(
  tx: TenantTx,
  q: { text?: string; pack?: string; category?: string; limit?: number },
): Promise<ServedSkillSummary[]> {
  const text = q.text?.trim() || null;
  const like = text ? `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const tsq = text ? sql`websearch_to_tsquery('simple', ${text})` : sql`NULL::tsquery`;
  const res = await tx.execute<ServedSkillSummary & { rank: number }>(sql`
    SELECT s.id, v.version, v.title, s.pack, s.category, v.body ->> 'when_to_use' AS when_to_use,
           ${text ? sql`ts_rank(v.search, ${tsq}) + CASE WHEN v.title ILIKE ${like} THEN 1 ELSE 0 END` : sql`0`}::float8 AS rank
      FROM skills s
      JOIN skill_versions v ON v.skill_id = s.id AND v.version = s.approved_version
     WHERE s.status <> 'retired' AND s.approved_version IS NOT NULL
       ${text ? sql`AND (v.search @@ ${tsq} OR v.title ILIKE ${like})` : sql``}
       ${q.pack ? sql`AND s.pack = ${q.pack}` : sql``}
       ${q.category ? sql`AND s.category = ${q.category}` : sql``}
     ORDER BY rank DESC, s.updated_at DESC
     LIMIT ${Math.min(q.limit ?? 10, 50)}`);
  return res.rows.map(({ rank: _rank, ...r }) => ({ ...r, version: Number(r.version) }));
}

export async function getServedSkill(tx: TenantTx, id: string): Promise<SkillLookup> {
  const [skill] = await tx.select().from(skills).where(eq(skills.id, id));
  if (!skill) return { status: "not_found" };
  if (skill.status === "retired") return { status: "retired", title: skill.title };
  if (!skill.approvedVersion) return { status: "not_approved", title: skill.title };
  const [v] = await tx
    .select()
    .from(skillVersions)
    .where(and(eq(skillVersions.skillId, id), eq(skillVersions.version, skill.approvedVersion)));
  if (!v) return { status: "not_found" };
  const approved = await tx.execute<{ at: Date }>(sql`
    SELECT max(created_at) AS at FROM skill_reviews
     WHERE skill_id = ${id} AND version = ${v.version} AND action IN ('approve', 'rollback', 'restore')`);
  const at = approved.rows[0]?.at;
  return {
    status: "served",
    skill: {
      id,
      version: v.version,
      title: v.title,
      pack: skill.pack,
      category: skill.category,
      when_to_use: v.body.when_to_use,
      body: v.body,
      evidence: { success: v.evidence.success.length, failure: v.evidence.failure.length },
      approved_at: at ? new Date(at).toISOString() : null,
    },
  };
}

/** Served skills in the categories a member subscribed to. */
export async function subscribedSkills(tx: TenantTx, memberId: string): Promise<ServedSkill[]> {
  const res = await tx.execute<{ id: string }>(sql`
    SELECT DISTINCT s.id, s.updated_at FROM skills s
      JOIN skill_subscriptions sub ON sub.pack = s.pack AND sub.category IN (s.category, '*')
     WHERE sub.member_id = ${memberId} AND s.status <> 'retired' AND s.approved_version IS NOT NULL
     ORDER BY s.updated_at DESC
     LIMIT 50`);
  const out: ServedSkill[] = [];
  for (const r of res.rows) {
    const found = await getServedSkill(tx, r.id);
    if (found.status === "served") out.push(found.skill);
  }
  return out;
}

export async function listSubscriptions(tx: TenantTx, memberId: string) {
  return tx
    .select({ pack: skillSubscriptions.pack, category: skillSubscriptions.category })
    .from(skillSubscriptions)
    .where(eq(skillSubscriptions.memberId, memberId));
}

export async function setSubscription(
  tx: TenantTx,
  tenantId: string,
  input: { memberId: string; pack: string; category: string; on: boolean },
): Promise<void> {
  if (input.on) {
    await tx
      .insert(skillSubscriptions)
      .values({ tenantId, memberId: input.memberId, pack: input.pack, category: input.category })
      .onConflictDoNothing();
  } else {
    await tx
      .delete(skillSubscriptions)
      .where(
        and(
          eq(skillSubscriptions.memberId, input.memberId),
          eq(skillSubscriptions.pack, input.pack),
          eq(skillSubscriptions.category, input.category),
        ),
      );
  }
}

// --- SKILL.md export ----------------------------------------------------------------------------

/** A Claude Code skill name: lowercase letters, digits and hyphens, at most 64 characters. */
export function skillSlug(s: { id: string; title: string }): string {
  const words = s.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return `mm-${words || "skill"}-${s.id.slice(0, 8)}`;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Exports a served skill as a SKILL.md file (Claude Code's skill format). */
export function skillMarkdown(s: ServedSkill): string {
  const description = oneLine(`${s.title}. Use when: ${s.when_to_use}`).slice(0, 1000);
  const lines = [
    "---",
    `name: ${skillSlug(s)}`,
    // JSON string quoting is valid YAML and escapes anything the text contains.
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${oneLine(s.title)}`,
    "",
    `_Team skill from Master Mind, version ${s.version} (${s.pack} / ${s.category}). Learned from ${s.evidence.success} successful and ${s.evidence.failure} unsuccessful tasks, and approved by a reviewer._`,
    "",
    "## When to use",
    "",
    oneLine(s.body.when_to_use),
  ];
  if (s.body.preconditions.length) {
    lines.push(
      "",
      "## Before you start",
      "",
      ...s.body.preconditions.map((p) => `- ${oneLine(p)}`),
    );
  }
  lines.push("", "## Steps", "", ...s.body.steps.map((st, i) => `${i + 1}. ${oneLine(st.text)}`));
  if (s.body.anti_patterns.length) {
    lines.push("", "## Avoid", "", ...s.body.anti_patterns.map((a) => `- ${oneLine(a.text)}`));
  }
  lines.push(
    "",
    "## Expected outcome",
    "",
    oneLine(s.body.expected_outcome),
    "",
    "## Tell Master Mind",
    "",
    `When you follow this skill, pass \`skills_used: [{ skill_id: "${s.id}", version: ${s.version} }]\` to log_task (or call record_skill_use), so the team can see whether it helps.`,
    "",
  );
  return lines.join("\n");
}
