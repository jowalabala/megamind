// Skill delivery for agents: search, read, and record use. Agents only ever see approved
// versions; a retired skill disappears from search and get_skill says it's retired.
import { agentSessions, and, eq, tasks, type AuthenticatedAgent, type MasterMindDb } from "@mm/db";
import { IngestForbiddenError, recordSkillUses, type RecordSkillUseInput } from "@mm/ingest";
import type { SearchSkillsInput, SkillOutput } from "@mm/mcp";
import {
  getServedSkill,
  searchServedSkills,
  skillMarkdown,
  skillSlug,
  subscribedSkills,
} from "@mm/skills";

function requireScope(agent: AuthenticatedAgent, scope: AuthenticatedAgent["scopes"][number]) {
  if (!agent.scopes.includes(scope)) {
    throw new IngestForbiddenError(
      `This agent key does not have the ${scope} scope. Create a new key in Settings → Agents.`,
    );
  }
}

export function skillHandlers(
  db: MasterMindDb,
  agent: AuthenticatedAgent,
  source: "mcp" | "bridge",
) {
  return {
    async search(input: SearchSkillsInput) {
      requireScope(agent, "skills:read");
      const skills = await db.withTenant(agent.tenantId, (tx) =>
        searchServedSkills(tx, { text: input.query, category: input.category, limit: input.limit }),
      );
      return { skills };
    },

    async get(input: { skill_id: string }): Promise<SkillOutput> {
      requireScope(agent, "skills:read");
      const found = await db.withTenant(agent.tenantId, (tx) => getServedSkill(tx, input.skill_id));
      if (found.status !== "served") return { status: found.status };
      const s = found.skill;
      return {
        status: "served",
        skill: {
          id: s.id,
          version: s.version,
          title: s.title,
          pack: s.pack,
          category: s.category,
          when_to_use: s.when_to_use,
          preconditions: s.body.preconditions,
          steps: s.body.steps.map((x) => ({ text: x.text })),
          anti_patterns: s.body.anti_patterns.map((x) => ({ text: x.text })),
          expected_outcome: s.body.expected_outcome,
          evidence: s.evidence,
        },
      };
    },

    async recordUse(input: RecordSkillUseInput) {
      requireScope(agent, "capture:write");
      if (agent.captureOptOut)
        return { recorded: false, reason: "this member has opted out of capture" };
      return db.withTenant(agent.tenantId, async (tx) => {
        if (input.task_id) {
          const [t] = await tx
            .select({ memberId: tasks.memberId })
            .from(tasks)
            .where(eq(tasks.id, input.task_id));
          if (!t || t.memberId !== agent.memberId) {
            return { recorded: false, reason: "that task_id isn't one of your tasks" };
          }
        }
        const [session] = input.session
          ? await tx
              .select({ id: agentSessions.id })
              .from(agentSessions)
              .where(
                and(
                  eq(agentSessions.agentIdentityId, agent.agentId),
                  eq(agentSessions.clientSessionId, input.session.id),
                ),
              )
          : [];
        const stored = await recordSkillUses(
          tx,
          agent.tenantId,
          {
            memberId: agent.memberId,
            agentId: agent.agentId,
            sessionId: session?.id ?? null,
            taskId: input.task_id ?? null,
            source,
            usedAt: new Date(),
            key: `${agent.agentId}:${input.task_id ?? input.session?.id ?? "none"}`,
          },
          [{ skillId: input.skill_id, version: input.version, adherence: input.adherence }],
        );
        return stored.length
          ? { recorded: true }
          : { recorded: false, reason: "no such skill version, or already recorded" };
      });
    },

    /** Approved skills in the member's subscribed categories, as SKILL.md files. */
    async subscribed() {
      requireScope(agent, "skills:read");
      const skills = await db.withTenant(agent.tenantId, (tx) =>
        subscribedSkills(tx, agent.memberId),
      );
      return {
        skills: skills.map((s) => ({
          id: s.id,
          version: s.version,
          title: s.title,
          category: s.category,
          when_to_use: s.when_to_use,
          slug: skillSlug(s),
          markdown: skillMarkdown(s),
        })),
      };
    },
  };
}
