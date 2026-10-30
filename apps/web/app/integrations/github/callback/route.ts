import { appendAuditEvent } from "@mm/audit";
import { AccountAlreadyLinkedError, ConnectionConflictError, connectionRepo } from "@mm/db";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { requireMemberContext } from "../../../../lib/context";
import { db } from "../../../../lib/db";
import { githubConfig, STATE_COOKIE, verifyGithubUser, verifyState } from "../../../../lib/github";

const back = (q: string): never => redirect(`/settings/integrations?${q}`);

/** GitHub's setup URL and OAuth callback, for both the install and the link flows. */
export async function GET(req: NextRequest) {
  const ctx = await requireMemberContext();
  const cfg = githubConfig();
  if (!cfg) back("error=not_configured");
  const jar = await cookies();
  const state = verifyState(req.nextUrl.searchParams.get("state"), jar.get(STATE_COOKIE)?.value);
  jar.delete({ name: STATE_COOKIE, path: "/integrations/github" });
  // The flow must finish as the same member, in the same workspace, that started it.
  if (!state || state.tenantId !== ctx.tenantId || state.memberId !== ctx.member.id) {
    back("error=expired");
  }
  const code = req.nextUrl.searchParams.get("code");
  // Installing needs "Request user authorization (OAuth) during installation" on the App.
  if (!code) back("error=no_code");

  let verified: Awaited<ReturnType<typeof verifyGithubUser>>;
  try {
    verified = await verifyGithubUser(cfg!, code!);
  } catch {
    back("error=github");
  }
  const installationId = req.nextUrl.searchParams.get("installation_id");

  try {
    await db().withTenant(ctx.tenantId, async (tx) => {
      if (state!.kind === "install" && installationId) {
        if (ctx.member.role !== "admin") back("error=admins_only");
        const inst = verified!.installations.find((i) => String(i.id) === installationId);
        if (!inst) back("error=not_your_installation");
        const { connection, created } = await connectionRepo.upsertGithubInstallation(
          tx,
          ctx.tenantId,
          {
            installationId,
            accountLogin: inst!.account?.login ?? null,
            createdByMemberId: ctx.member.id,
          },
        );
        await appendAuditEvent(tx, ctx.tenantId, {
          actorType: "member",
          actorId: ctx.member.id,
          action: created ? "connection.created" : "connection.reconnected",
          targetType: "connection",
          targetId: connection.id,
          payload: { provider: "github" },
        });
      }
      // Either flow links the person who went through it.
      const { claimedTasks } = await connectionRepo.linkGithubAccount(
        tx,
        ctx.member.id,
        verified!.userId,
      );
      await appendAuditEvent(tx, ctx.tenantId, {
        actorType: "member",
        actorId: ctx.member.id,
        action: "member.github_linked",
        targetType: "member",
        targetId: ctx.member.id,
        payload: { claimedTasks },
      });
    });
  } catch (err) {
    if (err instanceof ConnectionConflictError) back("error=other_workspace");
    if (err instanceof AccountAlreadyLinkedError) back("error=already_linked");
    throw err;
  }
  back(state!.kind === "install" ? "ok=installed" : "ok=linked");
}
