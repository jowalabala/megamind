// A small Slack Web API client: just the calls Master Mind makes. The bot only posts direct
// messages and looks people up by their work email; it reads no channels or messages.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SLACK_SCOPES = ["chat:write", "users:read", "users:read.email"] as const;

export class SlackError extends Error {
  override name = "SlackError";
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? `Slack error: ${code}`);
  }
}

export interface SlackApi {
  call<T = Record<string, unknown>>(method: string, args: Record<string, unknown>): Promise<T>;
}

/** Form-encoded calls (Slack accepts them for every method); objects are sent as JSON fields. */
export function slackApi(options: {
  token?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}): SlackApi {
  const base = (options.baseUrl ?? "https://slack.com/api").replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  return {
    async call<T>(method: string, args: Record<string, unknown>) {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(args)) {
        if (v === undefined) continue;
        form.set(k, typeof v === "string" ? v : JSON.stringify(v));
      }
      const res = await doFetch(`${base}/${method}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        body: form,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 429) throw new SlackError("ratelimited");
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new SlackError(body.error ?? `http_${res.status}`);
      return body as T;
    },
  };
}

export interface SlackOauthResult {
  accessToken: string;
  teamId: string;
  teamName: string | null;
  authedUserId: string | null;
}

/** Exchanges an OAuth code for the workspace's bot token. */
export async function slackOauthAccess(
  cfg: { clientId: string; clientSecret: string; redirectUri: string; baseUrl?: string },
  code: string,
): Promise<SlackOauthResult> {
  const res = await slackApi({ baseUrl: cfg.baseUrl }).call<{
    access_token?: string;
    token_type?: string;
    team?: { id: string; name?: string };
    authed_user?: { id?: string };
  }>("oauth.v2.access", {
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: cfg.redirectUri,
  });
  if (!res.access_token || res.token_type !== "bot" || !res.team?.id) {
    throw new SlackError("no_bot_token", "Slack didn't return a bot token.");
  }
  return {
    accessToken: res.access_token,
    teamId: res.team.id,
    teamName: res.team.name ?? null,
    authedUserId: res.authed_user?.id ?? null,
  };
}

/**
 * Verifies a request from Slack (signing secret, v0 scheme). Requests older than five
 * minutes are refused, so a captured request can't be replayed later.
 */
export function verifySlackRequest(
  signingSecret: string,
  headers: { timestamp?: string; signature?: string },
  rawBody: Buffer | string,
  now = Date.now(),
): boolean {
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return false;
  if (!headers.signature?.startsWith("v0=")) return false;
  const expected = createHmac("sha256", signingSecret)
    .update(`v0:${headers.timestamp}:`)
    .update(rawBody)
    .digest();
  const given = Buffer.from(headers.signature.slice(3), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Signs a body the way Slack does. For tests and local tools. */
export function signSlackRequest(signingSecret: string, timestamp: number, rawBody: string) {
  return `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}
