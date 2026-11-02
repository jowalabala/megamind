import { desc, outcomeImports } from "@mm/db";
import { editablePack, packToYaml, type Condition } from "@mm/packs";
import { requireAdminContext } from "../../../lib/context";
import { db } from "../../../lib/db";
import { TopBar } from "../../top-bar";
import { CategoryForm, MetricForm, RemoveButton, RuleForm, UploadForm, YamlForm } from "./forms";

export const dynamic = "force-dynamic";

const OPS: Record<Condition["op"], string> = {
  eq: "=",
  ne: "≠",
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
};
const BASELINES: Record<string, string> = {
  p25: "the team's 25th percentile",
  p50: "the team's median",
  p75: "the team's 75th percentile",
  mean: "the team's average",
};
const describe = (c: Condition) =>
  `${c.metric} ${OPS[c.op]} ${c.baseline ? BASELINES[c.baseline] : c.value}`;

export default async function MetricsPage() {
  const ctx = await requireAdminContext();
  const { pack, version } = await editablePack(db(), ctx.tenantId, "generic");
  const imports = await db().withTenant(ctx.tenantId, (tx) =>
    tx.select().from(outcomeImports).orderBy(desc(outcomeImports.createdAt)).limit(5),
  );

  return (
    <>
      <TopBar tenantName={ctx.tenant.name} email={ctx.user.email} />
      <main>
        <h1>Metrics</h1>
        <p className="muted">
          Work that GitHub and HubSpot don&apos;t cover (finance, HR, operations, anything your
          agents log) is judged by the categories, metrics and rules here. Results come from agents
          (<code>report_outcome</code>) or from a CSV upload. Version {version || "built-in"}; every
          change is a new version, and earlier work keeps the rules it was judged by.
        </p>

        <div className="card">
          <h2>Categories</h2>
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th>What belongs here</th>
                <th>Matched by title</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pack.categories.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.name} <code className="muted">{c.id}</code>
                  </td>
                  <td>{c.description}</td>
                  <td className="muted">
                    {c.rules
                      .map((r) => r.title)
                      .filter(Boolean)
                      .join(" or ") ||
                      (c.id === pack.fallback ? "anything else" : "agents' hints and the model")}
                  </td>
                  <td>
                    {c.id !== pack.fallback && (
                      <RemoveButton version={version} what="category" id={c.id} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <details>
            <summary>Add a category</summary>
            <CategoryForm version={version} />
          </details>
        </div>

        <div className="card">
          <h2>Metrics</h2>
          {pack.metrics.length === 0 ? (
            <p className="muted">No metrics yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Unit</th>
                  <th>Better</th>
                  <th>Final after</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pack.metrics.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <code>{m.id}</code> <span className="muted">{m.description}</span>
                    </td>
                    <td>{m.unit}</td>
                    <td>{m.better}</td>
                    <td>{m.window_days !== undefined ? `${m.window_days} days` : "at once"}</td>
                    <td>
                      <RemoveButton version={version} what="metric" id={m.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <details>
            <summary>Add a metric</summary>
            <MetricForm version={version} />
          </details>
        </div>

        <div className="card">
          <h2>What counts as success</h2>
          {!pack.judge ? (
            <p className="muted">No rules yet, so this work isn&apos;t judged.</p>
          ) : (
            <ul>
              {pack.judge.success_if_all.map((c, i) => (
                <li key={`s${i}`}>
                  Success needs {describe(c)}{" "}
                  <RemoveButton version={version} what="success" index={i} />
                </li>
              ))}
              {pack.judge.failure_if_any.map((c, i) => (
                <li key={`f${i}`}>
                  Failure if {describe(c)}{" "}
                  <RemoveButton version={version} what="failure" index={i} />
                </li>
              ))}
            </ul>
          )}
          <p className="muted">
            Comparing with the team&apos;s own history needs{" "}
            {pack.judge?.baseline.min_samples ?? 20} earlier results; until then the verdict is
            &ldquo;inconclusive&rdquo;.
          </p>
          <RuleForm version={version} metrics={pack.metrics.map((m) => m.id)} />
        </div>

        <div className="card">
          <h2>Upload outcomes (CSV)</h2>
          <p className="muted">
            One row per result. Columns: <code>ref</code>, <code>metric</code>, <code>value</code>,
            and optionally <code>n</code>, <code>observed_at</code>, <code>title</code>,{" "}
            <code>owner_email</code>, <code>completed_at</code>, <code>category</code>.{" "}
            <code>ref</code> names the work, like <code>jira:issue:FIN-12</code> or a task id; a new
            ref with a title and the owner&apos;s work email adds that work. Up to 5,000 rows and 2
            MB. Uploading the same file again adds nothing.
          </p>
          <pre>
            {
              "ref,metric,value,title,owner_email,completed_at\njira:issue:FIN-12,close.days_late,0,March close,dana@acme.com,2026-04-03"
            }
          </pre>
          <UploadForm />
          {imports.length > 0 && (
            <>
              <h3>Recent uploads</h3>
              <ul>
                {imports.map((i) => (
                  <li key={i.id}>
                    {i.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC: {i.rows} rows,{" "}
                    {i.stored} stored, {i.problems.length} with problems
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <details className="card">
          <summary>Edit as YAML (advanced)</summary>
          <p className="muted">
            The same pack in the format of the built-in packs. It&apos;s checked in full before
            it&apos;s saved.
          </p>
          <YamlForm version={version} yaml={packToYaml(pack)} />
        </details>
      </main>
    </>
  );
}
