import { sql } from "@mm/db";
import { listSubscriptions, searchSkills } from "@mm/skills";
import { requireMemberContext } from "../../lib/context";
import { db } from "../../lib/db";
import { TopBar } from "../top-bar";
import { subscribe } from "./actions";

export const dynamic = "force-dynamic";

export default async function SkillsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const ctx = await requireMemberContext();
  const { q, status } = await searchParams;
  const { list, categories, subs } = await db().withTenant(ctx.tenantId, async (tx) => ({
    list: await searchSkills(tx, {
      text: q?.slice(0, 200),
      status: status && ["approved", "in_review", "retired"].includes(status) ? status : undefined,
    }),
    categories: (
      await tx.execute<{ pack: string; category: string; served: number }>(sql`
        SELECT pack, category,
               count(*) FILTER (WHERE status <> 'retired' AND approved_version IS NOT NULL)::int AS served
          FROM skills GROUP BY pack, category ORDER BY pack, category`)
    ).rows,
    subs: await listSubscriptions(tx, ctx.member.id),
  }));
  const following = (pack: string, category: string) =>
    subs.some((x) => x.pack === pack && (x.category === category || x.category === "*"));
  return (
    <>
      <TopBar tenantName={ctx.tenant.name} email={ctx.user.email} />
      <main>
        <h1>Skills</h1>
        <p className="muted">
          Practices learned from what worked on your team, each grounded in the work it came from.{" "}
          <a href="/skills/review">Review queue</a>
        </p>
        <form className="inline" method="get">
          <input type="text" name="q" defaultValue={q ?? ""} placeholder="Search skills" />
          <select name="status" defaultValue={status ?? ""}>
            <option value="">Any status</option>
            <option value="approved">Approved</option>
            <option value="in_review">In review</option>
            <option value="retired">Retired</option>
          </select>
          <button type="submit">Search</button>
        </form>
        <div className="card">
          {list.length === 0 ? (
            <p className="muted">No skills{q ? ` match "${q}"` : " yet"}.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Skill</th>
                  <th>Category</th>
                  <th>Status</th>
                  <th>Version</th>
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <a href={`/skills/${s.id}`}>{s.title}</a>
                    </td>
                    <td className="muted">{s.category}</td>
                    <td>
                      <span className="pill">{s.status.replace("_", " ")}</span>
                    </td>
                    <td className="muted">
                      v{s.current_version}
                      {s.approved_version && s.approved_version !== s.current_version
                        ? ` (serving v${s.approved_version})`
                        : ""}
                      {s.flagged ? " · flagged" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <h2>Follow categories</h2>
        <p className="muted">
          Approved skills in the categories you follow are installed for your agents by the bridge
          (as Claude Code skills, at the start of each session), and you hear about changes in
          Slack. Every agent can still search all approved skills.
        </p>
        <div className="card">
          {categories.length === 0 ? (
            <p className="muted">No skills yet.</p>
          ) : (
            <table>
              <tbody>
                {categories.map((c) => {
                  const on = following(c.pack, c.category);
                  return (
                    <tr key={`${c.pack}/${c.category}`}>
                      <td>
                        {c.category} <span className="muted">({c.pack})</span>
                      </td>
                      <td className="muted">{c.served} served</td>
                      <td>
                        <form action={subscribe}>
                          <input type="hidden" name="pack" value={c.pack} />
                          <input type="hidden" name="category" value={c.category} />
                          <input type="hidden" name="on" value={on ? "false" : "true"} />
                          <button type="submit">{on ? "Unfollow" : "Follow"}</button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </>
  );
}
