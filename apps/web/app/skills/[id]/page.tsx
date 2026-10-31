import { notFound } from "next/navigation";
import { canReview, getSkill } from "@mm/skills";
import { requireMemberContext } from "../../../lib/context";
import { db } from "../../../lib/db";
import { TopBar } from "../../top-bar";
import { review } from "../actions";

export const dynamic = "force-dynamic";

export default async function SkillPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireMemberContext();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const data = await db().withTenant(ctx.tenantId, async (tx) => {
    const s = await getSkill(tx, id);
    return s ? { ...s, mayReview: await canReview(tx, ctx.member.id, s.skill) } : null;
  });
  if (!data) notFound();
  const { skill, versions, reviews, evidence, mayReview } = data;
  const current = versions[0]!;
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const gate = current.gate as {
    rubric?: Record<string, number | string>;
    verify?: { dropped?: number };
  };

  return (
    <>
      <TopBar tenantName={ctx.tenant.name} email={ctx.user.email} />
      <main>
        <p className="muted">
          <a href="/skills">Skills</a> · {skill.category}
        </p>
        <h1>{current.title}</h1>
        <p>
          <span className="pill">{skill.status.replace("_", " ")}</span>{" "}
          <span className="muted">
            v{skill.currentVersion}
            {skill.approvedVersion
              ? ` · agents get v${skill.approvedVersion}`
              : " · not served yet"}
          </span>
        </p>
        <div className="card">
          <p>
            <strong>When:</strong> {current.body.when_to_use}
          </p>
          {current.body.preconditions.length > 0 && (
            <p>
              <strong>Before you start:</strong> {current.body.preconditions.join("; ")}
            </p>
          )}
          <h2>Steps</h2>
          <ol>
            {current.body.steps.map((s, i) => (
              <li key={i}>
                {s.text}
                <div className="muted">
                  Seen in:{" "}
                  {s.evidence
                    .map((e) => byId.get(e)?.refs?.[0] ?? byId.get(e)?.title ?? e.slice(0, 8))
                    .join(", ")}
                </div>
              </li>
            ))}
          </ol>
          {current.body.anti_patterns.length > 0 && (
            <>
              <h2>What didn&apos;t work</h2>
              <ul>
                {current.body.anti_patterns.map((a, i) => (
                  <li key={i}>{a.text}</li>
                ))}
              </ul>
            </>
          )}
          <p>
            <strong>Expected:</strong> {current.body.expected_outcome}
          </p>
          <p className="muted">
            Grounded in {current.evidence.success.length} successful and{" "}
            {current.evidence.failure.length} comparable unsuccessful tasks.{" "}
            {gate.rubric &&
              `Quality scores: specificity ${gate.rubric.specificity}, actionability ${gate.rubric.actionability}, groundedness ${gate.rubric.groundedness}, generality ${gate.rubric.generality}, safety ${gate.rubric.safety}.`}{" "}
            {gate.verify?.dropped ? `${gate.verify.dropped} unsupported step(s) removed.` : ""}
          </p>
        </div>

        {mayReview && (
          <>
            <h2>Review</h2>
            <div className="card">
              <form action={review} className="inline">
                <input type="hidden" name="skillId" value={skill.id} />
                <input type="text" name="note" placeholder="Note (optional)" />
                {skill.status === "in_review" && (
                  <>
                    <button type="submit" name="action" value="approve">
                      Approve v{skill.currentVersion}
                    </button>
                    <button type="submit" name="action" value="reject" className="danger">
                      Reject
                    </button>
                  </>
                )}
                {skill.status === "approved" && (
                  <button type="submit" name="action" value="retire" className="danger">
                    Retire
                  </button>
                )}
                {skill.status === "retired" && (
                  <button type="submit" name="action" value="restore">
                    Restore
                  </button>
                )}
              </form>
            </div>
          </>
        )}

        <h2>Versions</h2>
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Title</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.version}>
                  <td>
                    v{v.version}
                    {v.version === skill.approvedVersion ? " (served)" : ""}
                  </td>
                  <td>{v.title}</td>
                  <td className="muted">{v.createdAt.toISOString().slice(0, 10)}</td>
                  <td>
                    {mayReview &&
                      v.version !== skill.approvedVersion &&
                      v.version !== skill.currentVersion && (
                        <form action={review}>
                          <input type="hidden" name="skillId" value={skill.id} />
                          <input type="hidden" name="version" value={v.version} />
                          <button type="submit" name="action" value="rollback">
                            Roll back to this
                          </button>
                        </form>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2>History</h2>
        <div className="card">
          {reviews.length === 0 ? (
            <p className="muted">No reviews yet.</p>
          ) : (
            <ul>
              {reviews.map((r) => (
                <li key={r.id}>
                  {r.createdAt.toISOString().slice(0, 16).replace("T", " ")}: {r.action} v
                  {r.version}
                  {r.note ? ` (${r.note})` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </>
  );
}
