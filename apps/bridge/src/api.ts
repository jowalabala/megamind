// Calls to the Master Mind API with the agent key. Short timeouts: hooks must stay fast.
import { CLIENT_HEADER } from "./config.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Api {
  post<T>(path: string, body: unknown, timeoutMs?: number): Promise<T>;
  get<T>(path: string, timeoutMs?: number): Promise<T>;
}

export function createApi(apiUrl: string, key: string): Api {
  const base = apiUrl.replace(/\/+$/, "");
  async function call<T>(method: string, path: string, body: unknown, timeoutMs: number) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        "x-mm-client": CLIENT_HEADER,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text) as { message?: string; error?: string };
        message = j.message ?? j.error ?? message;
      } catch {
        // not JSON
      }
      throw new ApiError(res.status, message);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
  return {
    post: (path, body, timeoutMs = 10_000) => call("POST", path, body, timeoutMs),
    get: (path, timeoutMs = 10_000) => call("GET", path, undefined, timeoutMs),
  };
}
