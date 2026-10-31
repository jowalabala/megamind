import { appendAuditEvent } from "@mm/audit";
import { ConnectionConflictError, connectionRepo, eq, members } from "@mm/db";
import { botTokenPurpose, slackOauthAccess } from "@mm/slack";
import { vaultFromEnv } from "@mm/vault";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { requireMemberContext } from "../../../../lib/context";
import { db } from "../../../../lib/db";
import { slackConfig, stateCookie, statePath, verifyOauthState } from "../../../../lib/oauth-state";

const back = (q: string): never => redirect(`/settings/integrations?${q}`);

/** Slack's OAuth callback: stores the workspace's bot token, sealed. */
export async function GET(req: NextRequest) {
  const ctx = await requireMemberContext();
  const cfg = slackConfig();
  const vault = vaultFromEnv();
  if (!cfg || !vault) back("error=slack_not_configured");
  const jar = await cookies();
  const state = verifyOauthState(
    "slack",
    req.nextUrl.searchParams.get("state"),
    jar.get(stateCookie("slack"))?.value,
  );
  jar.delete({ name: stateCookie("slack"), path: statePath("slack") });
  if (!state || state.tenantId !== ctx.tenantId || state.memberId !== ctx.member.id) {
    back("error=expired");
  }
  if (ctx.member.role !== "admin") back("error=admins_only");
  const code = req.nextUrl.searchParams.get("code");
  if (!code) back("error=slack");

  let result: Awaited<ReturnType<typeof slackOauthAccess>>;
  try {
    result = await slackOauthAccess(cfg!, code!);
  } catch {
    back("error=slack");
  }
  try {
    await db().withTenant(ctx.tenantId, async (tx) => {
      const { connection, created } = await connectionRepo.upsertConnection(tx, ctx.tenantId, {
        provider: "slack",
        externalId: result!.teamId,
        accountLogin: result!.teamName,
        createdByMemberId: ctx.member.id,
      });
      const sealed = await vault!.seal(
        ctx.tenantId,
        botTokenPurpose(connection.id),
        result!.accessToken,
      );
      await connectionRepo.saveSecret(tx, ctx.tenantId, connection.id, "bot_token", sealed);
      // The admin who installed it just proved who they are in Slack.
      const slackUser = result!.authedUserId;
      if (slackUser && /^[A-Z0-9]{2,32}$/.test(slackUser)) {
        const [taken] = await tx
          .select({ id: members.id })
          .from(members)
          .where(eq(members.slackUserId, slackUser));
        if (!taken) {
          await tx
            .update(members)
            .set({ slackUserId: slackUser })
            .where(eq(members.id, ctx.member.id));
        }
      }
      await appendAuditEvent(tx, ctx.tenantId, {
        actorType: "member",
        actorId: ctx.member.id,
        action: created ? "connection.created" : "connection.reconnected",
        targetType: "connection",
        targetId: connection.id,
        payload: { provider: "slack" },
      });
    });
  } catch (err) {
    if (err instanceof ConnectionConflictError) back("error=other_workspace");
    throw err;
  }
  back("ok=slack_installed");
}
