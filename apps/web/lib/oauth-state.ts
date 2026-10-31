// Signed OAuth state for the HubSpot and Slack install flows: bound to the member who started
// it, their tenant, the provider, and a nonce kept in an httpOnly cookie; valid 10 minutes.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type OauthProvider = "hubspot" | "slack";

interface State {
  provider: OauthProvider;
  tenantId: string;
  memberId: string;
  nonce: string;
  exp: number;
}

export const stateCookie = (p: OauthProvider) => `mm_${p}_state`;
export const statePath = (p: OauthProvider) => `/integrations/${p}`;

function key(p: OauthProvider): Buffer {
  const secret = process.env.WORKOS_COOKIE_PASSWORD;
  if (!secret || secret.length < 32)
    throw new Error("WORKOS_COOKIE_PASSWORD (32+ chars) is required");
  return createHmac("sha256", secret).update(`mm:${p}-oauth-state`).digest();
}

export function signOauthState(s: Omit<State, "nonce" | "exp">): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({ ...s, nonce, exp: Date.now() + 10 * 60_000 } satisfies State),
  ).toString("base64url");
  const mac = createHmac("sha256", key(s.provider)).update(body).digest("base64url");
  return { state: `${body}.${mac}`, nonce };
}

export function verifyOauthState(
  provider: OauthProvider,
  state: string | null,
  cookieNonce: string | undefined,
): State | null {
  if (!state || !cookieNonce) return null;
  const [body, mac] = state.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", key(provider)).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const s = JSON.parse(Buffer.from(body, "base64url").toString()) as State;
  if (s.provider !== provider || s.exp < Date.now() || s.nonce !== cookieNonce) return null;
  return s;
}

export function slackConfig() {
  const clientId = process.env.MM_SLACK_CLIENT_ID;
  const clientSecret = process.env.MM_SLACK_CLIENT_SECRET;
  const redirectUri = process.env.MM_SLACK_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return {
    clientId,
    clientSecret,
    redirectUri,
    baseUrl: process.env.MM_SLACK_API_URL || undefined,
    authorizeUrl: (process.env.MM_SLACK_WEB_URL ?? "https://slack.com").replace(/\/+$/, ""),
  };
}
