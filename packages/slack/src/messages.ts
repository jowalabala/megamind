// What each notification looks like in Slack. Text comes from Master Mind's own records
// (already redacted); it is escaped so it can't form links or mentions.

export const ACTIONS = {
  approve: "mm_channel_approve",
  decline: "mm_channel_decline",
} as const;

/** Escapes the three characters Slack's mrkdwn treats as control characters. */
export const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, 1500);

type Block = Record<string, unknown>;
export interface SlackMessage {
  text: string;
  blocks: Block[];
}

const section = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text } });
const link = (text: string, url: string): Block => ({
  type: "button",
  text: { type: "plain_text", text },
  url,
});

export function renderNotification(
  kind: string,
  p: Record<string, unknown>,
  webUrl: string,
): SlackMessage {
  const web = webUrl.replace(/\/+$/, "");
  switch (kind) {
    case "channel_request": {
      const who = p.requested_by_you
        ? "Your agent wants to open a channel"
        : `${esc(p.requester)}'s agent wants to open a channel with your agent`;
      const share = Array.isArray(p.share) ? p.share.map(esc).join(", ") : "";
      const resources =
        Array.isArray(p.resources) && p.resources.length
          ? `\nScope: ${p.resources.map((r) => `\`${esc(r)}\``).join(", ")}`
          : "";
      const text = `${who}: "${esc(p.purpose)}". Shares ${share} for up to ${Number(p.ttl_minutes)} minutes.${resources}`;
      return {
        text: `${who}. Approve or decline in Master Mind.`,
        blocks: [
          section(`${text}\nIt opens only when both people approve.`),
          {
            type: "actions",
            block_id: `mm_channel:${esc(p.channel_id)}`,
            elements: [
              {
                type: "button",
                action_id: ACTIONS.approve,
                text: { type: "plain_text", text: "Approve" },
                style: "primary",
                value: String(p.channel_id),
              },
              {
                type: "button",
                action_id: ACTIONS.decline,
                text: { type: "plain_text", text: "Decline" },
                style: "danger",
                value: String(p.channel_id),
              },
              link("Open in Master Mind", `${web}/channels`),
            ],
          },
        ],
      };
    }
    case "skill_review": {
      const text = `A skill is waiting for your review: *${esc(p.title)}* (v${Number(p.version)}, ${esc(p.category)}).`;
      return {
        text: `A skill is waiting for your review: ${esc(p.title)}`,
        blocks: [
          section(text),
          { type: "actions", elements: [link("Review", `${web}/skills/${esc(p.skill_id)}`)] },
        ],
      };
    }
    case "skill_flagged": {
      const text = `*${esc(p.title)}* (v${Number(p.version)}) looks like it's hurting results. ${esc(p.reason)} It's still served until someone decides.`;
      return {
        text: `A served skill was flagged: ${esc(p.title)}`,
        blocks: [
          section(text),
          { type: "actions", elements: [link("Review", `${web}/skills/${esc(p.skill_id)}`)] },
        ],
      };
    }
    case "skill_approved":
    case "skill_retired": {
      const verb =
        kind === "skill_approved"
          ? `is now served to agents (v${Number(p.version)})`
          : "was retired; agents no longer receive it";
      return {
        text: `${esc(p.title)} ${verb}`,
        blocks: [
          section(`A skill you follow, *${esc(p.title)}* (${esc(p.category)}), ${verb}.`),
          { type: "actions", elements: [link("Open", `${web}/skills/${esc(p.skill_id)}`)] },
        ],
      };
    }
    default:
      return { text: "Update from Master Mind", blocks: [section("Update from Master Mind.")] };
  }
}
