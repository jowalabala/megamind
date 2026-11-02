import { auditEvents, dashboardRepo, desc, MIN_PEOPLE } from "@mm/db";
import { requireMemberContext } from "../../lib/context";
import { db } from "../../lib/db";
import { TopBar } from "../top-bar";

export const dynamic = "force-dynamic";

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const SOURCES: Record<string, string> = {
  bridge: "Coding agents (bridge)",
  mcp: "Agents (MCP)",
  github: "GitHub pull requests",
  hubspot: "HubSpot",
  csv: "CSV uploads",
  ui: "Entered by hand",
};

export default async function Dashboard() {
  const ctx = await requireMemberContext();
  const isAdmin = ctx.member.role === "admin";
  const data = await db().withTenant(ctx.tenantId, async (tx) => ({
    stats: await dashboardRepo.pilotStats(tx),
    steps: isAdmin ? await dashboardRepo.onboardingSteps(tx, ctx.tenantId) : [],
    recent: isAdmin
      ? await tx.select().from(auditEvents).orderBy(desc(auditEvents.seq)).limit(10)
      : [],
  }));
  const { stats, steps } = data;
  const required = steps.filter((s) => !s.optional);
  const setupDone = required.every((s) => s.done);
  const maxWeek = Math.max(1, ...stats.weekly.map((w) => w.tasks));
  const captured = Object.values(stats.tasksBySource).reduce((a, b) => a + b, 0);

  return (
    <>
      <TopBar tenantName={ctx.tenant.name} email={ctx.user.email} />
      <main>
        <h1>Welcome{ctx.user.firstName ? `, ${ctx.user.firstName}` : ""}</h1>
        <p className="muted">
          You&apos;re signed in to <strong>{ctx.tenant.name}</strong> as{" "}
          <span className="pill">{ctx.member.role}</span>
        </p>

        {isAdmin && !setupDone && (
          <div className="card">
            <h2>
              Set up the pilot ({required.filter((s) => s.done).length} of {required.length})
            </h2>
            <ul className="checklist">
              {steps.map((s) => (
                <li key={s.id} className={s.done ? "done" : undefined}>
                  {s.done ? "✓" : "○"} <a href={s.href}>{s.title}</a>
                  {s.optional && <span className="muted"> (optional)</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        <h2>Last 30 days</h2>
        <div className="grid">
          <div className="card stat">
            <strong>{captured}</strong> units of work captured
          </div>
          <div className="card stat">
            <strong>{stats.skills.served}</strong> skills serving agents
            {stats.skills.inReview > 0 && (
              <span className="muted"> · {stats.skills.inReview} waiting for review</span>
            )}
          </div>
          <div className="card stat">
            <strong>{stats.skills.uses}</strong> times agents followed a skill
          </div>
          <div className="card stat">
            <strong>{stats.collaboration.overlaps}</strong> overlaps caught
            <span className="muted"> · {stats.collaboration.channelsOpened} channels opened</span>
          </div>
        </div>

        <div className="card">
          <h2>Work captured per week</h2>
          {stats.weekly.length === 0 ? (
            <p className="muted">Nothing yet. Connect GitHub or an agent to start.</p>
          ) : (
            <>
              <div className="bars" role="img" aria-label="Units of work captured per week">
                {stats.weekly.map((w) => (
                  <div
                    key={w.week}
                    title={`Week of ${w.week}: ${w.tasks}`}
                    style={{ height: `${(w.tasks / maxWeek) * 100}%` }}
                  />
                ))}
              </div>
              <p className="muted">
                {Object.entries(stats.tasksBySource)
                  .map(([s, n]) => `${SOURCES[s] ?? s}: ${n}`)
                  .join(" · ")}
              </p>
            </>
          )}
        </div>

        <div className="card">
          <h2>Outcomes (last 90 days)</h2>
          {stats.outcomes.length === 0 ? (
            <p className="muted">
              No judged work yet. Outcomes arrive as results become final (for example 30 days after
              a pull request merges).
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Area</th>
                  <th>Judged</th>
                  <th>Success rate</th>
                  <th>Inconclusive</th>
                </tr>
              </thead>
              <tbody>
                {stats.outcomes.map((o) => (
                  <tr key={o.pack}>
                    <td>{o.pack}</td>
                    <td>{o.judged}</td>
                    <td>
                      {pct(o.successRate)}
                      {o.successRate === null && o.people < MIN_PEOPLE && (
                        <span className="muted"> (shown once {MIN_PEOPLE} people contribute)</span>
                      )}
                    </td>
                    <td>{o.inconclusive}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted">
            Team-level only: Master Mind never shows success or failure per person.
            {stats.skills.improving > 0 &&
              ` ${stats.skills.improving} skill(s) measurably improve results.`}
            {stats.skills.flagged > 0 && ` ${stats.skills.flagged} skill(s) flagged for review.`}
          </p>
        </div>

        {isAdmin && (
          <>
            <h2>Recent audit events</h2>
            <div className="card">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((e) => (
                    <tr key={e.id}>
                      <td>{e.seq}</td>
                      <td>
                        <code>{e.action}</code>
                      </td>
                      <td className="muted">{e.actorType}</td>
                      <td className="muted">
                        {e.occurredAt.toISOString().replace("T", " ").slice(0, 19)} UTC
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </>
  );
}
