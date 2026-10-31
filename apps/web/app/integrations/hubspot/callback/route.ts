import { appendAuditEvent } from "@mm/audit";
import { ConnectionConflictError, connectionRepo } from "@mm/db";
import { exchangeCode, hubspotConfigFromEnv, storeRefreshToken, tokenInfo } from "@mm/hubspot";
import { vaultFromEnv } from "@mm/vault";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { requireMemberContext } from "../../../../lib/context";
import { db } from "../../../../lib/db";
import { stateCookie, statePath, verifyOauthState } from "../../../../lib/oauth-state";

const back = (q: string): never => redirect(`/settings/integrations?${q}`);

/** HubSpot's OAuth callback. The refresh token is sealed before it's stored; nothing else is kept. */
export async function GET(req: NextRequest) {
  const ctx = await requireMemberContext();
  const cfg = hubspotConfigFromEnv();
  const vault = vaultFromEnv();
  if (!cfg || !vault) back("error=hubspot_not_configured");
  const jar = await cookies();
  const state = verifyOauthState(
    "hubspot",
    req.nextUrl.searchParams.get("state"),
    jar.get(stateCookie("hubspot"))?.value,
  );
  jar.delete({ name: stateCookie("hubspot"), path: statePath("hubspot") });
  if (!state || state.tenantId !== ctx.tenantId || state.memberId !== ctx.member.id) {
    back("error=expired");
  }
  if (ctx.member.role !== "admin") back("error=admins_only");
  const code = req.nextUrl.searchParams.get("code");
  if (!code) back("error=hubspot");

  let portal: { hubId: string; hubDomain: string | null };
  let refreshToken: string;
  try {
    const tokens = await exchangeCode(cfg!, code!);
    portal = await tokenInfo(cfg!, tokens.accessToken);
    refreshToken = tokens.refreshToken;
  } catch {
    back("error=hubspot");
  }
  try {
    const connectionId = await db().withTenant(ctx.tenantId, async (tx) => {
      const { connection, created } = await connectionRepo.upsertConnection(tx, ctx.tenantId, {
        provider: "hubspot",
        externalId: portal!.hubId,
        accountLogin: portal!.hubDomain,
        createdByMemberId: ctx.member.id,
      });
      await appendAuditEvent(tx, ctx.tenantId, {
        actorType: "member",
        actorId: ctx.member.id,
        action: created ? "connection.created" : "connection.reconnected",
        targetType: "connection",
        targetId: connection.id,
        payload: { provider: "hubspot" },
      });
      return connection.id;
    });
    await storeRefreshToken({ db: db(), vault: vault! }, ctx.tenantId, connectionId, refreshToken!);
  } catch (err) {
    if (err instanceof ConnectionConflictError) back("error=other_workspace");
    throw err;
  }
  back("ok=hubspot_installed");
}
