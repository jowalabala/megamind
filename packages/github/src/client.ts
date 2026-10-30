// A small GitHub App client: App JWT -> installation token -> REST and GraphQL.
// Tokens are minted per installation, cached until shortly before they expire, and never
// stored. The base URL is configurable for GitHub Enterprise and for tests.
import { createSign } from "node:crypto";

export interface GithubAppConfig {
  appId: string;
  /** PEM private key of the GitHub App. */
  privateKey: string;
  /** Default https://api.github.com */
  apiUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class GithubError extends Error {
  override name = "GithubError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Over the rate limit: try again at `retryAt`. */
export class RateLimitedError extends Error {
  override name = "RateLimitedError";
  constructor(readonly retryAt: Date) {
    super(`GitHub rate limit reached; retry after ${retryAt.toISOString()}`);
  }
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** A JWT that authenticates as the App itself (10 minutes max, per GitHub). */
export function appJwt(appId: string, privateKey: string, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // Backdated a minute for clock drift.
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
}

export interface InstallationClient {
  rest<T>(method: string, path: string, body?: unknown): Promise<T>;
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
}

export interface GithubApp {
  installation(installationId: string): InstallationClient;
  /** Raw App-level call (authenticated with the App JWT). */
  appRequest<T>(method: string, path: string): Promise<T>;
}

function rateLimitFrom(res: Response, now: number): RateLimitedError | null {
  if (res.status !== 403 && res.status !== 429) return null;
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) return new RateLimitedError(new Date(now + Number(retryAfter) * 1000));
  if (res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
    return new RateLimitedError(new Date(Math.max(reset, now + 60_000)));
  }
  return null;
}

export function createGithubApp(config: GithubAppConfig): GithubApp {
  const base = (config.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  const tokens = new Map<string, { token: string; expiresAt: number }>();

  async function call<T>(method: string, path: string, auth: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: auth,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "master-mind",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const limited = rateLimitFrom(res, now());
    if (limited) throw limited;
    if (!res.ok) {
      const text = await res.text();
      let message = `GitHub ${method} ${path.split("?")[0]} failed: ${res.status}`;
      try {
        message += ` ${(JSON.parse(text) as { message?: string }).message ?? ""}`.trimEnd();
      } catch {
        // not JSON
      }
      throw new GithubError(res.status, message);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  async function installationToken(id: string): Promise<string> {
    const hit = tokens.get(id);
    if (hit && hit.expiresAt - now() > 5 * 60_000) return hit.token;
    const res = await call<{ token: string; expires_at: string }>(
      "POST",
      `/app/installations/${encodeURIComponent(id)}/access_tokens`,
      `Bearer ${appJwt(config.appId, config.privateKey, now())}`,
    );
    tokens.set(id, { token: res.token, expiresAt: Date.parse(res.expires_at) });
    return res.token;
  }

  return {
    appRequest: (method, path) =>
      call(method, path, `Bearer ${appJwt(config.appId, config.privateKey, now())}`),
    installation(id) {
      return {
        async rest<T>(method: string, path: string, body?: unknown) {
          return call<T>(method, path, `token ${await installationToken(id)}`, body);
        },
        async graphql<T>(query: string, variables: Record<string, unknown>) {
          const res = await call<{ data?: T; errors?: { type?: string; message: string }[] }>(
            "POST",
            "/graphql",
            `bearer ${await installationToken(id)}`,
            { query, variables },
          );
          if (res.errors?.length) {
            if (res.errors.some((e) => e.type === "RATE_LIMITED")) {
              throw new RateLimitedError(new Date(now() + 15 * 60_000));
            }
            const notFound = res.errors.find((e) => e.type === "NOT_FOUND");
            throw new GithubError(notFound ? 404 : 502, `GraphQL: ${res.errors[0]!.message}`);
          }
          return res.data as T;
        },
      };
    },
  };
}
