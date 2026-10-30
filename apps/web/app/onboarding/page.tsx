import { withAuth } from "@workos-inc/authkit-nextjs";
import { CreateOrgForm } from "./form";

export const dynamic = "force-dynamic";

export default async function Onboarding() {
  const { user } = await withAuth({ ensureSignedIn: true });
  return (
    <main>
      <h1>Set up your organization</h1>
      <p className="muted">
        Signed in as {user.email}. If a teammate already set up Master Mind, ask them for an invite
        instead.
      </p>
      <div className="card">
        <CreateOrgForm />
      </div>
    </main>
  );
}
