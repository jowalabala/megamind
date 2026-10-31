import { authorizeUrl, hubspotConfigFromEnv } from "@mm/hubspot";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireMemberContext } from "../../../../lib/context";
import { signOauthState, stateCookie, statePath } from "../../../../lib/oauth-state";

/** Admin-only: sends the browser to HubSpot to authorize read-only access. */
export async function GET() {
  const ctx = await requireMemberContext();
  const cfg = hubspotConfigFromEnv();
  if (!cfg) redirect("/settings/integrations?error=hubspot_not_configured");
  if (ctx.member.role !== "admin") redirect("/settings/integrations?error=admins_only");
  const { state, nonce } = signOauthState({
    provider: "hubspot",
    tenantId: ctx.tenantId,
    memberId: ctx.member.id,
  });
  (await cookies()).set(stateCookie("hubspot"), nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: statePath("hubspot"),
  });
  redirect(authorizeUrl(cfg!, state));
}
