import { memberRepo } from "@mm/db";
import { reviewQueue } from "@mm/skills";
import { requireMemberContext } from "../../../lib/context";
import { db } from "../../../lib/db";
import { TopBar } from "../../top-bar";
import { assignOwner } from "../actions";

export const dynamic = "force-dynamic";

export default async function ReviewQueuePage() {
  const ctx = await requireMemberContext();
  const isAdmin = ctx.member.role === "admin";
  const { queue, people } = await db().withTenant(ctx.tenantId, async (tx) => ({
    queue: await reviewQueue(tx, ctx.member.id),
    people: isAdmin ? await memberRepo.listMembers(tx) : [],
  }));
  return (
    <>
      <TopBar tenantName={ctx.tenant.name} email={ctx.user.email} />
      <main>
        <h1>Review queue</h1>
        <p className="muted">
          New skills and new versions wait here until an admin or the category&apos;s owner approves
          them. Nothing reaches agents before that.
        </p>
        <div className="card">
          {queue.length === 0 ? (
            <p className="muted">Nothing waiting for you.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Skill</th>
                  <th>Category</th>
                  <th>Version</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <a href={`/skills/${s.id}`}>{s.title}</a>
                    </td>
                    <td className="muted">{s.category}</td>
                    <td className="muted">v{s.current_version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {isAdmin && (
          <>
            <h2>Category owners</h2>
            <div className="card">
              <form action={assignOwner} className="inline">
                <select name="memberId" required>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName ?? p.email}
                    </option>
                  ))}
                </select>
                <input type="hidden" name="pack" value="engineering" />
                <input type="text" name="category" placeholder="Category, e.g. bugfix" required />
                <button type="submit" name="owner" value="true">
                  Make owner
                </button>
                <button type="submit" name="owner" value="false" className="danger">
                  Remove
                </button>
              </form>
            </div>
          </>
        )}
      </main>
    </>
  );
}
