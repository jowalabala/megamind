import { SLACK_SCOPES } from "@mm/slack";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireMemberContext } from "../../../../lib/context";
import { signOauthState, slackConfig, stateCookie, statePath } from "../../../../lib/oauth-state";

/** Admin-only: adds the Master Mind bot to the company's Slack workspace. */
export async function GET() {
  const ctx = await requireMemberContext();
  const cfg = slackConfig();
  if (!cfg) redirect("/settings/integrations?error=slack_not_configured");
  if (ctx.member.role !== "admin") redirect("/settings/integrations?error=admins_only");
  const { state, nonce } = signOauthState({
    provider: "slack",
    tenantId: ctx.tenantId,
    memberId: ctx.member.id,
  });
  (await cookies()).set(stateCookie("slack"), nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: statePath("slack"),
  });
  const u = new URL(`${cfg!.authorizeUrl}/oauth/v2/authorize`);
  u.searchParams.set("client_id", cfg!.clientId);
  u.searchParams.set("scope", SLACK_SCOPES.join(","));
  u.searchParams.set("redirect_uri", cfg!.redirectUri);
  u.searchParams.set("state", state);
  redirect(u.toString());
}
