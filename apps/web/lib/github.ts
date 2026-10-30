// GitHub App install and account-link flows (web side).
//
// Both end at one callback that receives a one-time OAuth code. The code is exchanged for a
// short-lived user token, used only to read who the user is and which installations they can
// access, then discarded. That proves an installation id in the URL is really the user's:
// without it, anyone could paste another company's installation id into the callback.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface GithubWebConfig {
  appSlug: string;
  clientId: string;
  clientSecret: string;
  /** https://github.com (or a GitHub Enterprise host). */
  webUrl: string;
  apiUrl: string;
}

export function githubConfig(): GithubWebConfig | null {
  const appSlug = process.env.MM_GITHUB_APP_SLUG;
  const clientId = process.env.MM_GITHUB_CLIENT_ID;
  const clientSecret = process.env.MM_GITHUB_CLIENT_SECRET;
  if (!appSlug || !clientId || !clientSecret) return null;
  return {
    appSlug,
    clientId,
    clientSecret,
    webUrl: (process.env.MM_GITHUB_WEB_URL ?? "https://github.com").replace(/\/+$/, ""),
    apiUrl: (process.env.MM_GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""),
  };
}

export const STATE_COOKIE = "mm_gh_state";

export interface FlowState {
  kind: "install" | "link";
  tenantId: string;
  memberId: string;
  nonce: string;
  exp: number;
}

function stateKey(): Buffer {
  const secret = process.env.WORKOS_COOKIE_PASSWORD;
  if (!secret || secret.length < 32)
    throw new Error("WORKOS_COOKIE_PASSWORD (32+ chars) is required");
  return createHmac("sha256", secret).update("mm:github-oauth-state").digest();
}

/** A signed, 10-minute state value, bound to the member and a nonce kept in a cookie. */
export function signState(s: Omit<FlowState, "nonce" | "exp">): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({ ...s, nonce, exp: Date.now() + 10 * 60_000 } satisfies FlowState),
  ).toString("base64url");
  const mac = createHmac("sha256", stateKey()).update(body).digest("base64url");
  return { state: `${body}.${mac}`, nonce };
}

export function verifyState(
  state: string | null,
  cookieNonce: string | undefined,
): FlowState | null {
  if (!state || !cookieNonce) return null;
  const [body, mac] = state.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", stateKey()).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const s = JSON.parse(Buffer.from(body, "base64url").toString()) as FlowState;
  if (s.exp < Date.now() || s.nonce !== cookieNonce) return null;
  return s;
}

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`GitHub ${what} failed (${res.status})`);
  return (await res.json()) as T;
}

/** Exchanges the OAuth code, reads the user and their installations, drops the token. */
export async function verifyGithubUser(cfg: GithubWebConfig, code: string) {
  const tokenRes = await json<{ access_token?: string; error?: string }>(
    await fetch(`${cfg.webUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code }),
    }),
    "token exchange",
  );
  if (!tokenRes.access_token)
    throw new Error(`GitHub token exchange failed: ${tokenRes.error ?? "no token"}`);
  const headers = {
    authorization: `Bearer ${tokenRes.access_token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "master-mind",
  };
  const user = await json<{ id: number; login: string }>(
    await fetch(`${cfg.apiUrl}/user`, { headers }),
    "user lookup",
  );
  const installations: { id: number; account: { login: string } | null }[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await json<{ installations: typeof installations }>(
      await fetch(`${cfg.apiUrl}/user/installations?per_page=100&page=${page}`, { headers }),
      "installations lookup",
    );
    installations.push(...res.installations);
    if (res.installations.length < 100) break;
  }
  return { userId: user.id, installations };
}
