"use client";

import { useActionState } from "react";
import { createAgent } from "./actions";

const KINDS: [string, string][] = [
  ["claude_code", "Claude Code"],
  ["cursor", "Cursor"],
  ["chatgpt", "ChatGPT"],
  ["copilot", "Copilot"],
  ["custom", "Other / custom"],
];

export function CreateAgentForm({ apiUrl }: { apiUrl: string }) {
  const [state, action, pending] = useActionState(createAgent, undefined);
  return (
    <>
      <form className="inline" action={action}>
        <input
          type="text"
          name="name"
          placeholder="e.g. Dana's Claude Code"
          maxLength={100}
          required
        />
        <select name="kind" defaultValue="claude_code">
          {KINDS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create key"}
        </button>
      </form>
      {state && "error" in state && <p className="error">{state.error}</p>}
      {state && "ok" in state && (
        <div className="notice">
          <p>
            <strong>Key for {state.name}.</strong> Copy it now: it won&apos;t be shown again.
          </p>
          <pre className="secret">{state.key}</pre>
          <p className="muted">Claude Code: run this once in your terminal.</p>
          <pre className="secret">
            {`claude mcp add --transport http master-mind ${apiUrl}/mcp --header "Authorization: Bearer ${state.key}"`}
          </pre>
          <p className="muted">
            Or, for automatic capture of each step, the local bridge (run it, then paste the key
            when asked):
          </p>
          <pre className="secret">{`mm login --api-url ${apiUrl} && mm install`}</pre>
          <p className="muted">
            Other MCP clients: server URL <code>{apiUrl}/mcp</code>, header{" "}
            <code>Authorization: Bearer &lt;key&gt;</code>.
          </p>
        </div>
      )}
    </>
  );
}
