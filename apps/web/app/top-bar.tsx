import { signOut } from "@workos-inc/authkit-nextjs";

export function TopBar({ tenantName, email }: { tenantName: string; email: string }) {
  async function doSignOut() {
    "use server";
    await signOut({ returnTo: "/" });
  }
  return (
    <header className="top">
      <strong>Master Mind · {tenantName}</strong>
      <nav>
        <a href="/dashboard">Dashboard</a>
        <a href="/skills">Skills</a>
        <a href="/channels">Channels</a>
        <a href="/settings/members">Members</a>
        <a href="/settings/agents">Agents</a>
        <a href="/settings/integrations">Integrations</a>
        <a href="/settings/privacy">Privacy</a>
        <span className="muted">{email}</span>
        <form action={doSignOut}>
          <button className="link" type="submit">
            Sign out
          </button>
        </form>
      </nav>
    </header>
  );
}
