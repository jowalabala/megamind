import { searchSkills } from "@mm/skills";
import { requireMemberContext } from "../../lib/context";
import { db } from "../../lib/db";
import { TopBar } from "../top-bar";

export const dynamic = "force-dynamic";

export default async function SkillsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const ctx = await requireMemberContext();
  const { q, status } = await searchParams;
  const list = await db().withTenant(ctx.tenantId, (tx) =>
    searchSkills(tx, {
      text: q?.slice(0, 200),
      status: status && ["approved", "in_review", "retired"].includes(status) ? status : undefined,
    }),
  );
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </>
  );
}
