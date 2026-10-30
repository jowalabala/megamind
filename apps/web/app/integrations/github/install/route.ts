import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireMemberContext } from "../../../../lib/context";
import { githubConfig, signState, STATE_COOKIE } from "../../../../lib/github";

/** Admin-only: sends the browser to GitHub to install the App on an org. */
export async function GET() {
  const ctx = await requireMemberContext();
  const cfg = githubConfig();
  if (!cfg) redirect("/settings/integrations?error=not_configured");
  if (ctx.member.role !== "admin") redirect("/settings/integrations?error=admins_only");
  const { state, nonce } = signState({
    kind: "install",
    tenantId: ctx.tenantId,
    memberId: ctx.member.id,
  });
  (await cookies()).set(STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/integrations/github",
  });
  redirect(
    `${cfg.webUrl}/apps/${encodeURIComponent(cfg.appSlug)}/installations/new?state=${state}`,
  );
}
