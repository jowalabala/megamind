"use client";

import { useActionState } from "react";
import { eraseMember } from "./actions";

/** Behind a disclosure and a typed confirmation: this can't be undone. */
export function EraseMemberForm({ memberId, label }: { memberId: string; label: string }) {
  const [state, action, pending] = useActionState(eraseMember, undefined);
  if (state?.ok) return <p className="muted">{state.ok}</p>;
  return (
    <details>
      <summary className="muted">Remove…</summary>
      <form className="inline" action={action}>
        <input type="hidden" name="memberId" value={memberId} />
        <input
          type="text"
          name="confirm"
          placeholder="Type ERASE"
          aria-label={`Type ERASE to remove ${label} and erase their data`}
          autoComplete="off"
          required
        />
        <button className="danger" type="submit" disabled={pending}>
          {pending ? "Removing…" : "Remove and erase data"}
        </button>
        {state?.error && <p className="error">{state.error}</p>}
      </form>
    </details>
  );
}
