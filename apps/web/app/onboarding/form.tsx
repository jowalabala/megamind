"use client";

import { useActionState } from "react";
import { createOrganization } from "./actions";

export function CreateOrgForm() {
  const [state, action, pending] = useActionState(createOrganization, undefined);
  return (
    <form className="inline" action={action}>
      <input
        type="text"
        name="name"
        placeholder="Company name"
        required
        minLength={2}
        maxLength={100}
      />
      <button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create organization"}
      </button>
      {state?.error && <p className="error">{state.error}</p>}
    </form>
  );
}
