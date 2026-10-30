import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireMemberContext } from "../../../../lib/context";
import { githubConfig, signState, STATE_COOKIE } from "../../../../lib/github";

/** Any member: proves which GitHub account is theirs, so their PRs are credited to them. */
export async function GET() {
  const ctx = await requireMemberContext();
  const cfg = githubConfig();
  if (!cfg) redirect("/settings/integrations?error=not_configured");
  const { state, nonce } = signState({
    kind: "link",
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
  const q = new URLSearchParams({ client_id: cfg.clientId, state, allow_signup: "false" });
  redirect(`${cfg.webUrl}/login/oauth/authorize?${q}`);
}
