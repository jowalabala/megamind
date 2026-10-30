import { getSignInUrl, withAuth } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import { missingConfig } from "../lib/env";

export const dynamic = "force-dynamic";

export default async function Home() {
  const missing = missingConfig();
  if (missing.length > 0) {
    return (
      <main>
        <h1>Master Mind</h1>
        <div className="card">
          <p>
            Local setup isn&apos;t finished. Add these to <code>apps/web/.env.local</code>:
          </p>
          <ul>
            {missing.map((k) => (
              <li key={k}>
                <code>{k}</code>
              </li>
            ))}
          </ul>
          <p className="muted">
            See <code>.env.example</code> in the repo root.
          </p>
        </div>
      </main>
    );
  }

  const { user } = await withAuth();
  if (user) redirect("/dashboard");
  const signInUrl = await getSignInUrl();
  return (
    <main>
      <h1>Master Mind</h1>
      <p className="muted">Your team&apos;s proven playbooks, learned from what actually worked.</p>
      <a className="button" href={signInUrl}>
        Sign in
      </a>
    </main>
  );
}
