"use client";

import { useActionState } from "react";
import { inviteMember } from "./actions";

export function InviteForm() {
  const [state, action, pending] = useActionState(inviteMember, undefined);
  return (
    <form className="inline" action={action}>
      <input type="email" name="email" placeholder="teammate@company.com" required />
      <button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send invite"}
      </button>
      {state?.error && <p className="error">{state.error}</p>}
      {state?.ok && <p className="muted">{state.ok}</p>}
    </form>
  );
}
