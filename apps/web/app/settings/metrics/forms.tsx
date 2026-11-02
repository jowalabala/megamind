"use client";

import { useActionState } from "react";
import {
  addCategory,
  addMetric,
  addRule,
  removeItem,
  saveYaml,
  uploadOutcomes,
  type FormState,
} from "./actions";

type Action = (prev: FormState, f: FormData) => Promise<FormState>;

function Result({ state }: { state: FormState }) {
  if (!state) return null;
  return (
    <>
      {state.error && <p className="error">{state.error}</p>}
      {state.ok && <p className="muted">{state.ok}</p>}
      {state.problems && state.problems.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Line</th>
              <th>Problem</th>
            </tr>
          </thead>
          <tbody>
            {state.problems.map((p) => (
              <tr key={p.line}>
                <td>{p.line}</td>
                <td>{p.problem}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function useForm(action: Action) {
  return useActionState(action, undefined);
}

export function CategoryForm({ version }: { version: number }) {
  const [state, action, pending] = useForm(addCategory);
  return (
    <form action={action}>
      <input type="hidden" name="version" value={version} />
      <label>
        Name <input name="name" required maxLength={100} placeholder="Month-end close" />
      </label>
      <label>
        What belongs here{" "}
        <input
          name="description"
          required
          maxLength={500}
          placeholder="Closing the books for a month"
        />
      </label>
      <label>
        Title keywords (comma-separated, optional){" "}
        <input name="keywords" maxLength={500} placeholder="close, month-end, reconciliation" />
      </label>
      <button type="submit" disabled={pending}>
        Add category
      </button>
      <Result state={state} />
    </form>
  );
}

export function MetricForm({ version }: { version: number }) {
  const [state, action, pending] = useForm(addMetric);
  return (
    <form action={action}>
      <input type="hidden" name="version" value={version} />
      <label>
        Id <input name="id" required maxLength={100} placeholder="close.days_late" />
      </label>
      <label>
        Description{" "}
        <input name="description" maxLength={300} placeholder="Days past the deadline" />
      </label>
      <label>
        Unit{" "}
        <select name="unit" defaultValue="count">
          <option value="count">count</option>
          <option value="hours">hours</option>
          <option value="ratio">ratio (0 to 1)</option>
          <option value="boolean">yes/no (1 or 0)</option>
        </select>
      </label>
      <label>
        Better is{" "}
        <select name="better" defaultValue="lower">
          <option value="lower">lower</option>
          <option value="higher">higher</option>
        </select>
      </label>
      <label>
        Final after (days, optional) <input name="window_days" type="number" min={0} max={365} />
      </label>
      <button type="submit" disabled={pending}>
        Add metric
      </button>
      <Result state={state} />
    </form>
  );
}

export function RuleForm({ version, metrics }: { version: number; metrics: string[] }) {
  const [state, action, pending] = useForm(addRule);
  if (metrics.length === 0) return <p className="muted">Add a metric first.</p>;
  return (
    <form action={action} className="inline">
      <input type="hidden" name="version" value={version} />
      <select name="kind" defaultValue="success" aria-label="Rule kind">
        <option value="success">Success when</option>
        <option value="failure">Failure when</option>
      </select>
      <select name="metric" aria-label="Metric">
        {metrics.map((m) => (
          <option key={m}>{m}</option>
        ))}
      </select>
      <select name="op" defaultValue="lte" aria-label="Comparison">
        <option value="lte">≤</option>
        <option value="lt">&lt;</option>
        <option value="gte">≥</option>
        <option value="gt">&gt;</option>
        <option value="eq">=</option>
        <option value="ne">≠</option>
      </select>
      <select name="against" defaultValue="value" aria-label="Compared with">
        <option value="value">this number</option>
        <option value="p25">the team&apos;s 25th percentile</option>
        <option value="p50">the team&apos;s median</option>
        <option value="p75">the team&apos;s 75th percentile</option>
        <option value="mean">the team&apos;s average</option>
      </select>
      <input name="value" type="number" step="any" aria-label="Number" placeholder="number" />
      <button type="submit" disabled={pending}>
        Add rule
      </button>
      <Result state={state} />
    </form>
  );
}

export function RemoveButton(props: {
  version: number;
  what: string;
  id?: string;
  index?: number;
}) {
  const [state, action, pending] = useForm(removeItem);
  return (
    <form action={action} className="inline">
      <input type="hidden" name="version" value={props.version} />
      <input type="hidden" name="what" value={props.what} />
      <input type="hidden" name="id" value={props.id ?? ""} />
      <input type="hidden" name="index" value={props.index ?? ""} />
      <button className="link" type="submit" disabled={pending}>
        remove
      </button>
      {state?.error && <span className="error"> {state.error}</span>}
    </form>
  );
}

export function YamlForm({ version, yaml }: { version: number; yaml: string }) {
  const [state, action, pending] = useForm(saveYaml);
  return (
    <form action={action}>
      <input type="hidden" name="version" value={version} />
      <textarea
        name="yaml"
        defaultValue={yaml}
        rows={24}
        spellCheck={false}
        aria-label="Pack YAML"
      />
      <button type="submit" disabled={pending}>
        Save YAML
      </button>
      <Result state={state} />
    </form>
  );
}

export function UploadForm() {
  const [state, action, pending] = useForm(uploadOutcomes);
  return (
    <form action={action}>
      <input type="file" name="file" accept=".csv,text/csv" required aria-label="CSV file" />
      <button type="submit" disabled={pending}>
        {pending ? "Importing…" : "Upload outcomes"}
      </button>
      <Result state={state} />
    </form>
  );
}
