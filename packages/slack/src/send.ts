// Sends pending notifications as Slack direct messages. Without a Slack connection they're
// marked skipped: the web app shows the same approvals and reviews.
import {
  eq,
  members,
  notificationRepo,
  connectionRepo,
  type MasterMindDb,
  type Notification,
  type TenantTx,
} from "@mm/db";
import type { Vault } from "@mm/vault";
import { slackApi, SlackError, type SlackApi } from "./client.ts";
import { renderNotification } from "./messages.ts";

export const MAX_ATTEMPTS = 5;

export interface SendDeps {
  db: MasterMindDb;
  /** Needed only once Slack is connected (to open its bot token). */
  vault: Vault | null;
  webUrl: string;
  slackBaseUrl?: string;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export const botTokenPurpose = (connectionId: string) => `slack:${connectionId}:bot_token`;

/** The member's Slack user id, found once by their work email and then remembered. */
async function slackUserFor(tx: TenantTx, api: SlackApi, memberId: string): Promise<string | null> {
  const [m] = await tx
    .select({ email: members.email, slackUserId: members.slackUserId })
    .from(members)
    .where(eq(members.id, memberId));
  if (!m) return null;
  if (m.slackUserId) return m.slackUserId;
  try {
    const res = await api.call<{ user?: { id?: string; deleted?: boolean; is_bot?: boolean } }>(
      "users.lookupByEmail",
      { email: m.email },
    );
    const id = res.user && !res.user.deleted && !res.user.is_bot ? res.user.id : undefined;
    if (!id || !/^[A-Z0-9]{2,32}$/.test(id)) return null;
    await tx.update(members).set({ slackUserId: id }).where(eq(members.id, memberId));
    return id;
  } catch (err) {
    if (err instanceof SlackError && err.code === "users_not_found") return null;
    throw err;
  }
}

export async function sendNotifications(
  deps: SendDeps,
  tenantId: string,
  limit = 20,
): Promise<{ sent: number; skipped: number; failed: number }> {
  return deps.db.withTenant(tenantId, async (tx) => {
    const out = { sent: 0, skipped: 0, failed: 0 };
    const pending = await notificationRepo.claimPending(tx, limit);
    if (pending.length === 0) return out;
    const skipAll = async (reason: string) => {
      await notificationRepo.markNotifications(
        tx,
        pending.map((n) => n.id),
        { status: "skipped", error: reason },
      );
      out.skipped = pending.length;
      return out;
    };
    const conn = await connectionRepo.activeConnection(tx, "slack");
    if (!conn) return skipAll("slack_not_connected");
    const sealed = await connectionRepo.loadSecret(tx, conn.id, "bot_token");
    if (!sealed) return skipAll("slack_token_missing");
    if (!deps.vault) return skipAll("token_vault_not_configured");
    const token = await deps.vault.open(tenantId, botTokenPurpose(conn.id), sealed);
    const api = slackApi({ token, baseUrl: deps.slackBaseUrl });

    for (const n of pending as Notification[]) {
      try {
        const user = await slackUserFor(tx, api, n.memberId);
        if (!user) {
          await notificationRepo.markNotifications(tx, [n.id], {
            status: "skipped",
            error: "no Slack account with this member's email",
          });
          out.skipped++;
          continue;
        }
        const msg = renderNotification(n.kind, n.payload, deps.webUrl);
        await api.call("chat.postMessage", {
          channel: user,
          text: msg.text,
          blocks: msg.blocks,
          unfurl_links: false,
          unfurl_media: false,
        });
        await notificationRepo.markNotifications(tx, [n.id], { status: "sent" });
        out.sent++;
      } catch (err) {
        // Rate limited: stop here; everything left stays pending for the next run.
        if (err instanceof SlackError && err.code === "ratelimited") break;
        const giveUp = n.attempts + 1 >= MAX_ATTEMPTS;
        await notificationRepo.markNotifications(tx, [n.id], {
          status: giveUp ? "failed" : "pending",
          error: (err as Error).message,
        });
        if (giveUp) out.failed++;
      }
    }
    if (out.sent || out.failed) deps.log?.("notifications.sent", { tenantId, ...out });
    return out;
  });
}
