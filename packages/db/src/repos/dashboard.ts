// Numbers for the pilot dashboard and the onboarding checklist. Aggregates only: nothing here
// is per person, and success rates appear only when at least MIN_PEOPLE people contributed,
// so a rate can't single anyone out.
import { sql } from "drizzle-orm";
import type { TenantTx } from "../client.ts";

export const MIN_PEOPLE = 5;

export interface PackOutcomes {
  pack: string;
  judged: number;
  success: number;
  failure: number;
  neutral: number;
  inconclusive: number;
  people: number;
  /** Null when fewer than MIN_PEOPLE people contributed. */
  successRate: number | null;
}

export interface PilotStats {
  since: string;
  tasksBySource: Record<string, number>;
  weekly: { week: string; tasks: number }[];
  outcomes: PackOutcomes[];
  skills: { served: number; inReview: number; flagged: number; uses: number; improving: number };
  collaboration: { overlaps: number; channelsOpened: number; approvedInSlack: number };
}

const n = (v: unknown) => Number(v ?? 0);

export async function pilotStats(tx: TenantTx, now = new Date(), days = 30): Promise<PilotStats> {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const bySource = await tx.execute<{ source: string; n: number }>(sql`
    SELECT source::text, count(*)::int AS n FROM tasks WHERE created_at >= ${since} GROUP BY 1`);
  const weekly = await tx.execute<{ week: string; n: number }>(sql`
    SELECT to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week, count(*)::int AS n
      FROM tasks WHERE created_at >= ${new Date(now.getTime() - 56 * 86_400_000).toISOString()}
     GROUP BY 1 ORDER BY 1`);
  const outcomes = await tx.execute<{
    pack: string;
    verdict: string;
    n: number;
    people: number;
  }>(sql`
    SELECT j.pack, j.verdict, count(*)::int AS n,
           count(DISTINCT coalesce(t.member_id::text, t.actor_key))::int AS people
      FROM judgments j JOIN tasks t ON t.tenant_id = j.tenant_id AND t.id = j.task_id
     WHERE j.judged_at >= ${new Date(now.getTime() - 90 * 86_400_000).toISOString()}
     GROUP BY 1, 2`);
  const people = await tx.execute<{ pack: string; people: number }>(sql`
    SELECT j.pack, count(DISTINCT coalesce(t.member_id::text, t.actor_key))::int AS people
      FROM judgments j JOIN tasks t ON t.tenant_id = j.tenant_id AND t.id = j.task_id
     WHERE j.judged_at >= ${new Date(now.getTime() - 90 * 86_400_000).toISOString()}
     GROUP BY 1`);
  const packs = new Map<string, PackOutcomes>();
  for (const r of outcomes.rows) {
    const p = packs.get(r.pack) ?? {
      pack: r.pack,
      judged: 0,
      success: 0,
      failure: 0,
      neutral: 0,
      inconclusive: 0,
      people: 0,
      successRate: null,
    };
    p.judged += n(r.n);
    if (r.verdict in p) (p as unknown as Record<string, number>)[r.verdict] = n(r.n);
    packs.set(r.pack, p);
  }
  for (const r of people.rows) {
    const p = packs.get(r.pack);
    if (!p) continue;
    p.people = n(r.people);
    const decided = p.success + p.failure + p.neutral;
    p.successRate = p.people >= MIN_PEOPLE && decided > 0 ? p.success / decided : null;
  }
  const [skills] = (
    await tx.execute<{
      served: number;
      in_review: number;
      flagged: number;
      uses: number;
      improving: number;
    }>(sql`
      SELECT
        (SELECT count(*) FROM skills WHERE status <> 'retired' AND approved_version IS NOT NULL)::int AS served,
        (SELECT count(*) FROM skills WHERE status = 'in_review')::int AS in_review,
        (SELECT count(*) FROM skills WHERE flagged_at IS NOT NULL)::int AS flagged,
        (SELECT count(*) FROM skill_usage WHERE used_at >= ${since})::int AS uses,
        (SELECT count(DISTINCT skill_id) FROM (
           SELECT DISTINCT ON (skill_id) skill_id, status FROM skill_measurements
            ORDER BY skill_id, measured_at DESC) m WHERE m.status = 'improves')::int AS improving`)
  ).rows;
  const [collab] = (
    await tx.execute<{ overlaps: number; opened: number; slack: number }>(sql`
      SELECT
        (SELECT count(*) FROM session_overlaps WHERE first_seen_at >= ${since})::int AS overlaps,
        (SELECT count(*) FROM channels WHERE opened_at >= ${since})::int AS opened,
        (SELECT count(DISTINCT channel_id) FROM channel_participants
          WHERE approved_via = 'slack' AND decided_at >= ${since})::int AS slack`)
  ).rows;
  return {
    since,
    tasksBySource: Object.fromEntries(bySource.rows.map((r) => [r.source, n(r.n)])),
    weekly: weekly.rows.map((r) => ({ week: r.week, tasks: n(r.n) })),
    outcomes: [...packs.values()].sort((a, b) => a.pack.localeCompare(b.pack)),
    skills: {
      served: n(skills?.served),
      inReview: n(skills?.in_review),
      flagged: n(skills?.flagged),
      uses: n(skills?.uses),
      improving: n(skills?.improving),
    },
    collaboration: {
      overlaps: n(collab?.overlaps),
      channelsOpened: n(collab?.opened),
      approvedInSlack: n(collab?.slack),
    },
  };
}

export interface OnboardingStep {
  id: string;
  title: string;
  done: boolean;
  /** Steps a pilot can skip (Slack, HubSpot, extra metrics). */
  optional: boolean;
  href: string;
}

/** The pilot setup checklist, with each step's state read from the data. */
export async function onboardingSteps(tx: TenantTx, tenantId: string): Promise<OnboardingStep[]> {
  const [r] = (
    await tx.execute<Record<string, number | boolean>>(sql`
      SELECT
        (SELECT count(*) FROM members)::int AS members,
        (SELECT count(*) FROM connections WHERE provider = 'github' AND status = 'active')::int AS github,
        (SELECT count(*) FROM connections WHERE provider = 'github' AND backfill_status = 'done')::int AS github_done,
        (SELECT count(*) FROM connections WHERE provider = 'hubspot' AND status = 'active')::int AS hubspot,
        (SELECT count(*) FROM connections WHERE provider = 'slack' AND status = 'active')::int AS slack,
        (SELECT count(*) FROM agent_identities WHERE revoked_at IS NULL AND last_used_at IS NOT NULL)::int AS agents,
        (SELECT count(*) FROM category_owners)::int AS owners,
        (SELECT count(*) FROM tenant_packs)::int AS packs,
        (SELECT count(*) FROM skills WHERE approved_version IS NOT NULL)::int AS skills,
        (SELECT lake_ready_at IS NOT NULL FROM tenants WHERE id = ${tenantId}) AS lake`)
  ).rows;
  const v = (k: string) => n(r?.[k]);
  return [
    {
      id: "invite",
      title: "Invite your team",
      done: v("members") >= 2,
      optional: false,
      href: "/settings/members",
    },
    {
      id: "github",
      title: "Connect GitHub (read-only)",
      done: v("github") > 0,
      optional: false,
      href: "/settings/integrations",
    },
    {
      id: "history",
      title: "Import history (automatic once GitHub is connected)",
      done: v("github_done") > 0,
      optional: false,
      href: "/settings/integrations",
    },
    {
      id: "agent",
      title: "Connect a coding agent with the mm bridge",
      done: v("agents") > 0,
      optional: false,
      href: "/settings/agents",
    },
    {
      id: "reviewers",
      title: "Choose who reviews skills for each category",
      done: v("owners") > 0,
      optional: false,
      href: "/skills/review",
    },
    {
      id: "lake",
      title: "Lake set up (done by Master Mind)",
      done: r?.lake === true,
      optional: false,
      href: "/dashboard",
    },
    {
      id: "slack",
      title: "Connect Slack for approvals and alerts",
      done: v("slack") > 0,
      optional: true,
      href: "/settings/integrations",
    },
    {
      id: "hubspot",
      title: "Connect HubSpot (sales and marketing)",
      done: v("hubspot") > 0,
      optional: true,
      href: "/settings/integrations",
    },
    {
      id: "metrics",
      title: "Add metrics for other teams",
      done: v("packs") > 0,
      optional: true,
      href: "/settings/metrics",
    },
    {
      id: "skill",
      title: "Approve the first skill",
      done: v("skills") > 0,
      optional: true,
      href: "/skills/review",
    },
  ];
}
