"use client";

import { useActionState } from "react";
import { cancelDeletion, scheduleDeletion } from "./actions";

export function DeleteOrganizationForm({ name }: { name: string }) {
  const [state, action, pending] = useActionState(scheduleDeletion, undefined);
  return (
    <details>
      <summary className="error">Delete this organization…</summary>
      <form action={action}>
        <label>
          Type <strong>{name}</strong> to confirm{" "}
          <input name="confirm" autoComplete="off" required aria-label="Organization name" />
        </label>
        <button className="danger" type="submit" disabled={pending}>
          {pending ? "Scheduling…" : "Schedule deletion"}
        </button>
        {state?.error && <p className="error">{state.error}</p>}
      </form>
    </details>
  );
}

export function CancelDeletionForm() {
  const [state, action, pending] = useActionState(cancelDeletion, undefined);
  return (
    <form action={action}>
      <button type="submit" disabled={pending}>
        {pending ? "Cancelling…" : "Cancel the deletion"}
      </button>
      {state?.error && <p className="error">{state.error}</p>}
      {state?.ok && <p className="muted">{state.ok}</p>}
    </form>
  );
}
