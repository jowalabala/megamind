// Button clicks from Slack. The request is already verified (signing secret) by the caller.
// The person is identified by their Slack user id in the tenant's own connected workspace,
// matched earlier by their work email; agents have no way to produce one of these requests.
import { appendAuditEvent } from "@mm/audit";
import { CollabError, decide } from "@mm/collab";
import { eq, members, type MasterMindDb } from "@mm/db";
import { ACTIONS } from "./messages.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface BlockActions {
  type?: string;
  team?: { id?: string };
  user?: { id?: string };
  actions?: { action_id?: string; value?: string }[];
  response_url?: string;
}

export interface InteractionResult {
  /** Replaces the original message's text. */
  text: string;
  responseUrl: string | null;
}

/** Parses Slack's form body: a single `payload` field holding JSON. */
export function parseInteraction(rawBody: string): BlockActions | null {
  const payload = new URLSearchParams(rawBody).get("payload");
  if (!payload) return null;
  try {
    return JSON.parse(payload) as BlockActions;
  } catch {
    return null;
  }
}

export async function handleInteraction(
  deps: { db: MasterMindDb },
  p: BlockActions,
): Promise<InteractionResult | null> {
  const action = p.actions?.[0];
  if (p.type !== "block_actions" || !action) return null;
  const decision =
    action.action_id === ACTIONS.approve
      ? "approve"
      : action.action_id === ACTIONS.decline
        ? "decline"
        : null;
  // Link buttons also send block_actions; nothing to do for them.
  if (!decision) return null;
  const responseUrl = p.response_url ?? null;
  const reply = (text: string) => ({ text, responseUrl });

  const teamId = p.team?.id;
  const slackUser = p.user?.id;
  const channelId = action.value ?? "";
  if (!teamId || !slackUser || !UUID.test(channelId)) return reply("That request wasn't valid.");
  const conn = await deps.db.system.resolveConnection("slack", teamId);
  if (!conn || conn.status !== "active") {
    return reply("This Slack workspace isn't connected to Master Mind.");
  }
  return deps.db.withTenant(conn.tenantId, async (tx) => {
    const [member] = await tx
      .select({ id: members.id })
      .from(members)
      .where(eq(members.slackUserId, slackUser));
    if (!member) {
      return reply("Master Mind doesn't know your Slack account. Decide in the web app instead.");
    }
    try {
      const status = await decide(tx, conn.tenantId, {
        channelId,
        memberId: member.id,
        decision,
        via: "slack",
      });
      if (decision === "decline") return reply("You declined. The channel won't open.");
      return reply(
        status === "open"
          ? "You approved. The channel is open."
          : "You approved. It opens once the other person approves too.",
      );
    } catch (err) {
      if (!(err instanceof CollabError)) throw err;
      await appendAuditEvent(tx, conn.tenantId, {
        actorType: "member",
        actorId: member.id,
        action: "channel.decision_refused",
        targetType: "channel",
        targetId: channelId,
        payload: { via: "slack", reason: err.code },
      });
      return reply(err.message);
    }
  });
}

/**
 * Updates the original message through Slack's response_url. Only Slack's own hosts are
 * accepted (plus one configured for tests), so a forged URL can't make us call elsewhere.
 */
export async function respond(
  result: InteractionResult,
  allowedOrigins: string[] = ["https://hooks.slack.com"],
): Promise<boolean> {
  if (!result.responseUrl) return false;
  let url: URL;
  try {
    url = new URL(result.responseUrl);
  } catch {
    return false;
  }
  if (!allowedOrigins.includes(url.origin)) return false;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ replace_original: true, text: result.text }),
    signal: AbortSignal.timeout(5_000),
  });
  return res.ok;
}
