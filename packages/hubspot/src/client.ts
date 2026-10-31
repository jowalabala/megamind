// HubSpot's OAuth and the few read-only calls Master Mind makes.
//
// Written from HubSpot's public API docs; see ADR 0009 for what has and hasn't been checked
// against a live portal. The scopes are read-only, and contact reads ask for three date
// properties only: no names, emails or other contact details are requested or kept.

export const HUBSPOT_SCOPES = [
  "oauth",
  "automation.sequences.read",
  "crm.objects.owners.read",
  "crm.objects.contacts.read",
] as const;

export interface HubspotConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** https://api.hubapi.com, or a fake in tests. */
  apiUrl?: string;
  /** https://app.hubspot.com */
  appUrl?: string;
}

export class HubspotError extends Error {
  override name = "HubspotError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class HubspotRateLimitedError extends HubspotError {
  override name = "HubspotRateLimitedError";
  constructor(readonly retryAt: Date) {
    super(429, "HubSpot rate limit reached");
  }
}

const api = (cfg: { apiUrl?: string }) =>
  (cfg.apiUrl ?? "https://api.hubapi.com").replace(/\/+$/, "");

export function authorizeUrl(cfg: HubspotConfig, state: string): string {
  const u = new URL(
    `${(cfg.appUrl ?? "https://app.hubspot.com").replace(/\/+$/, "")}/oauth/authorize`,
  );
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("scope", HUBSPOT_SCOPES.join(" "));
  u.searchParams.set("state", state);
  return u.toString();
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

async function tokenCall(cfg: HubspotConfig, form: Record<string, string>): Promise<Tokens> {
  const res = await fetch(`${api(cfg)}/oauth/v1/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      ...form,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    message?: string;
  };
  if (!res.ok || !body.access_token || !body.refresh_token) {
    throw new HubspotError(res.status, `HubSpot token request failed (${res.status})`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    // A minute early, so a token never expires mid-request.
    expiresAt: new Date(Date.now() + ((body.expires_in ?? 1800) - 60) * 1000),
  };
}

export const exchangeCode = (cfg: HubspotConfig, code: string) =>
  tokenCall(cfg, { grant_type: "authorization_code", redirect_uri: cfg.redirectUri, code });

export const refreshTokens = (cfg: HubspotConfig, refreshToken: string) =>
  tokenCall(cfg, { grant_type: "refresh_token", refresh_token: refreshToken });

/** Which portal a token belongs to, and who authorized it. */
export async function tokenInfo(cfg: { apiUrl?: string }, accessToken: string) {
  const res = await fetch(`${api(cfg)}/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new HubspotError(res.status, `HubSpot token lookup failed (${res.status})`);
  const body = (await res.json()) as { hub_id?: number; hub_domain?: string; user?: string };
  if (!body.hub_id) throw new HubspotError(500, "HubSpot didn't say which portal this is.");
  return { hubId: String(body.hub_id), hubDomain: body.hub_domain ?? null };
}

export interface HubspotClient {
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export function hubspotClient(cfg: { apiUrl?: string }, accessToken: string): HubspotClient {
  const base = api(cfg);
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429) {
      const after = Number(res.headers.get("retry-after") ?? "10");
      throw new HubspotRateLimitedError(new Date(Date.now() + Math.max(1, after) * 1000));
    }
    if (!res.ok)
      throw new HubspotError(
        res.status,
        `HubSpot ${method} ${path.split("?")[0]} failed (${res.status})`,
      );
    return (await res.json()) as T;
  }
  return {
    get: (path, query) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) q.set(k, String(v));
      const qs = q.toString();
      return call("GET", qs ? `${path}?${qs}` : path);
    },
    post: (path, body) => call("POST", path, body),
  };
}

// --- Reads ----------------------------------------------------------------------------------------

type Paged<T> = { results: T[]; paging?: { next?: { after?: string } } };

async function* pages<T>(
  fetchPage: (after: string | undefined) => Promise<Paged<T>>,
  maxPages = 100,
): AsyncGenerator<T> {
  let after: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(after);
    yield* page.results;
    after = page.paging?.next?.after;
    if (!after) return;
  }
}

export interface Owner {
  id: string;
  userId: number | null;
  email: string | null;
}

export async function listOwners(c: HubspotClient): Promise<Owner[]> {
  const out: Owner[] = [];
  for await (const o of pages<{ id: string; userId?: number; email?: string; archived?: boolean }>(
    (after) => c.get("/crm/v3/owners", { limit: 100, after }),
  )) {
    if (o.archived) continue;
    out.push({ id: String(o.id), userId: o.userId ?? null, email: o.email ?? null });
  }
  return out;
}

export interface Sequence {
  id: string;
  name: string;
  userId: number;
  createdAt: Date;
  updatedAt: Date;
  steps: number;
  emailSteps: number;
  taskSteps: number;
}

interface RawSequence {
  id: string | number;
  name?: string;
  userId?: string | number;
  createdAt?: string;
  updatedAt?: string;
  steps?: { actionType?: string }[];
}

export const SEQUENCES_PATH = "/automation/v4/sequences";

function toSequence(raw: RawSequence, userId: number): Sequence | null {
  if (!raw.createdAt) return null;
  const steps = raw.steps ?? [];
  const isEmail = (s: { actionType?: string }) => /EMAIL/i.test(s.actionType ?? "");
  const isTask = (s: { actionType?: string }) => /TASK/i.test(s.actionType ?? "");
  return {
    id: String(raw.id),
    name: raw.name ?? "(unnamed sequence)",
    userId: Number(raw.userId ?? userId),
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt ?? raw.createdAt),
    steps: steps.length,
    emailSteps: steps.filter(isEmail).length,
    taskSteps: steps.filter(isTask).length,
  };
}

/** One user's sequences, with their step counts (the list omits steps, so each is fetched). */
export async function listSequences(c: HubspotClient, userId: number): Promise<Sequence[]> {
  const out: Sequence[] = [];
  for await (const s of pages<RawSequence>((after) =>
    c.get(SEQUENCES_PATH, { userId, limit: 100, after }),
  )) {
    const full = await c.get<RawSequence>(`${SEQUENCES_PATH}/${encodeURIComponent(String(s.id))}`, {
      userId,
    });
    const seq = toSequence(full, userId);
    if (seq) out.push(seq);
  }
  return out;
}

/** Contact date properties used to count outcomes. Nothing that identifies a person. */
export const OUTCOME_PROPERTIES = [
  "hs_latest_sequence_enrolled_date",
  "hs_sales_email_last_replied",
  "engagements_last_meeting_booked",
] as const;

export interface SequenceCounts {
  enrolled: number;
  replied: number;
  meetings: number;
}

/**
 * Counts contacts whose latest sequence is this one and who were enrolled before `matureBefore`
 * (so each had time to reply): how many replied, and how many booked a meeting, after enrolling.
 * Only counts leave this function; contact ids are dropped as each page is read.
 */
export async function sequenceCounts(
  c: HubspotClient,
  sequenceId: string,
  matureBefore: Date,
): Promise<SequenceCounts> {
  const counts = { enrolled: 0, replied: 0, meetings: 0 };
  const after = (a: string | undefined, b: string | undefined) =>
    Boolean(a && b && new Date(a).getTime() >= new Date(b).getTime());
  // The search API returns at most 10,000 results per query.
  for await (const contact of pages<{ properties?: Record<string, string | null> }>(
    (cursor) =>
      c.post("/crm/v3/objects/contacts/search", {
        filterGroups: [
          {
            filters: [
              { propertyName: "hs_latest_sequence_enrolled", operator: "EQ", value: sequenceId },
              {
                propertyName: "hs_latest_sequence_enrolled_date",
                operator: "LTE",
                value: String(matureBefore.getTime()),
              },
            ],
          },
        ],
        properties: [...OUTCOME_PROPERTIES],
        limit: 100,
        ...(cursor ? { after: cursor } : {}),
      }),
    100,
  )) {
    const p = contact.properties ?? {};
    const enrolled = p.hs_latest_sequence_enrolled_date ?? undefined;
    if (!enrolled) continue;
    counts.enrolled++;
    if (after(p.hs_sales_email_last_replied ?? undefined, enrolled)) counts.replied++;
    if (after(p.engagements_last_meeting_booked ?? undefined, enrolled)) counts.meetings++;
  }
  return counts;
}
