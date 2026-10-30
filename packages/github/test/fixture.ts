// A fixture GitHub: two repositories of PRs and a fake API server that serves them through
// the same REST and GraphQL calls the connector makes. It checks the App's JWT signature.
import { createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { GqlPr } from "../src/queries.ts";

export const APP_ID = "424242";
export const INSTALLATION_ID = "9001";
export const { privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

// Built at runtime so no secret-shaped literal is committed.
export const LEAKED_TOKEN = "ghp_" + "Zx81Kq0pLm7Tn2Vb5Rc9Wd4Ye6Uf3Ig1Ho8J".slice(0, 36);

export const DANA = 501; // linked member
export const LIOR = 502; // not linked
export const SAM = 503; // not linked
export const QUIET = 504; // linked, opted out of capture

const daysAgo = (d: number, h = 0) =>
  new Date(Date.now() - d * 86_400_000 + h * 3_600_000).toISOString();
const user = (id: number, login: string) => ({ __typename: "User", login, databaseId: id });
const bot = (login: string) => ({ __typename: "Bot", login, databaseId: 49699333 });

function pr(p: Partial<GqlPr> & { number: number; title: string; createdDaysAgo: number }): GqlPr {
  const created = daysAgo(p.createdDaysAgo);
  const state = p.state ?? "MERGED";
  const ended = state === "OPEN" ? null : daysAgo(p.createdDaysAgo, 20);
  return {
    databaseId: 100_000 + p.number,
    number: p.number,
    title: p.title,
    body: p.body ?? "",
    state,
    isDraft: p.isDraft ?? false,
    createdAt: created,
    updatedAt: ended ?? created,
    mergedAt: state === "MERGED" ? ended : null,
    closedAt: ended,
    author: p.author ?? user(LIOR, "lior"),
    additions: p.additions ?? 40,
    deletions: p.deletions ?? 10,
    changedFiles: p.files?.nodes.length ?? 1,
    baseRefName: "main",
    headRefName: p.headRefName ?? `branch-${p.number}`,
    headRefOid: "a".repeat(39) + (p.number % 10),
    mergeCommit: state === "MERGED" ? { oid: "b".repeat(39) + (p.number % 10) } : null,
    labels: p.labels ?? { nodes: [] },
    commits: p.commits ?? { totalCount: 2 },
    lastCommit: p.lastCommit ?? {
      nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }],
    },
    reviews: p.reviews ?? { nodes: [] },
    files: p.files ?? { nodes: [{ path: "src/app.ts", additions: 40, deletions: 10 }] },
    closingIssuesReferences: p.closingIssuesReferences ?? { nodes: [] },
  };
}

const files = (...paths: string[]) => ({
  nodes: paths.map((path) => ({ path, additions: 10, deletions: 2 })),
});

/** Newest first, like GitHub with orderBy CREATED_AT DESC. */
export function fixtureRepos() {
  const api: GqlPr[] = [
    pr({
      number: 20,
      title: "feat: quiet person's change",
      createdDaysAgo: 1,
      author: user(QUIET, "quiet"),
    }),
    pr({
      number: 19,
      title: "feat: invoice tax lines",
      createdDaysAgo: 2,
      state: "OPEN",
      isDraft: true,
      author: user(DANA, "dana"),
    }),
    pr({
      number: 18,
      title: "Faster CI cache",
      createdDaysAgo: 5,
      files: files(".github/workflows/ci.yml"),
    }),
    pr({ number: 17, title: "Split the invoice module into smaller pieces", createdDaysAgo: 8 }),
    pr({
      number: 16,
      title: "Rounding error on refunds",
      createdDaysAgo: 10,
      state: "CLOSED",
      author: user(SAM, "sam"),
      labels: { nodes: [{ name: "Bug" }] },
      body: `Reported by jane@customer.test. Repro used ${LEAKED_TOKEN} by mistake.`,
    }),
    pr({
      number: 15,
      title: "Update onboarding guide",
      createdDaysAgo: 20,
      files: files("README.md", "docs/onboarding.md"),
    }),
    pr({
      number: 14,
      title: "Bump lodash from 4.17.20 to 4.17.21",
      createdDaysAgo: 30,
      author: bot("dependabot"),
      files: files("package.json", "pnpm-lock.yaml"),
    }),
    pr({ number: 13, title: 'Revert "feat(billing): proration"', createdDaysAgo: 40 }),
    pr({
      number: 12,
      title: "feat(billing): proration for mid-cycle upgrades",
      createdDaysAgo: 45,
      author: user(DANA, "dana"),
      headRefName: "dana/proration",
      body: "Adds proration.\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
      files: files("src/billing/proration.ts", "src/billing/proration.test.ts"),
      reviews: {
        nodes: [
          { state: "CHANGES_REQUESTED", submittedAt: daysAgo(45, 3), author: user(LIOR, "lior") },
          { state: "APPROVED", submittedAt: daysAgo(45, 10), author: user(LIOR, "lior") },
        ],
      },
      closingIssuesReferences: { nodes: [{ number: 7 }] },
      commits: { totalCount: 4 },
    }),
    // Older than the 12-month backfill window: never fetched past here.
    pr({ number: 3, title: "feat: ancient history", createdDaysAgo: 420 }),
  ];
  const web: GqlPr[] = [pr({ number: 5, title: "fix: broken signup button", createdDaysAgo: 3 })];
  return {
    repos: [
      { id: 1001, full_name: "Acme/API", archived: false, prs: api },
      { id: 1002, full_name: "acme/web", archived: false, prs: web },
      { id: 1003, full_name: "acme/old-site", archived: true, prs: [] as GqlPr[] },
    ],
  };
}

export interface FakeGithub {
  url: string;
  data: ReturnType<typeof fixtureRepos>;
  calls: string[];
  /** Respond to the next N GraphQL calls with a rate-limit error. */
  rateLimitNext: number;
  close(): Promise<void>;
}

function verifyJwt(jwt: string): boolean {
  const [h, p, s] = jwt.split(".");
  if (!h || !p || !s) return false;
  const ok = createVerify("RSA-SHA256")
    .update(`${h}.${p}`)
    .verify(PUBLIC_KEY, Buffer.from(s, "base64url"));
  const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as { iss: string; exp: number };
  return ok && claims.iss === APP_ID && claims.exp * 1000 > Date.now();
}

export async function startFakeGithub(pageSize = 4): Promise<FakeGithub> {
  const data = fixtureRepos();
  const tokens = new Set<string>();
  const calls: string[] = [];
  const state = { rateLimitNext: 0 };

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status: number, json: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(json));
      };
      const url = new URL(req.url!, "http://x");
      const auth = req.headers.authorization ?? "";
      calls.push(`${req.method} ${url.pathname}`);

      if (
        req.method === "POST" &&
        url.pathname === `/app/installations/${INSTALLATION_ID}/access_tokens`
      ) {
        if (!verifyJwt(auth.replace(/^Bearer /, "")))
          return send(401, { message: "Bad credentials" });
        const token = `ghs_${randomBytes(18).toString("hex")}`;
        tokens.add(token);
        return send(201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }
      const token = auth.replace(/^(token|bearer) /i, "");
      if (!tokens.has(token)) return send(401, { message: "Bad credentials" });

      if (req.method === "GET" && url.pathname === "/installation/repositories") {
        return send(200, {
          repositories: data.repos.map(({ id, full_name, archived }) => ({
            id,
            full_name,
            archived,
          })),
        });
      }
      if (req.method === "POST" && url.pathname === "/graphql") {
        if (state.rateLimitNext > 0) {
          state.rateLimitNext--;
          return send(
            403,
            { message: "API rate limit exceeded" },
            {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600),
            },
          );
        }
        const { query, variables } = JSON.parse(body) as {
          query: string;
          variables: { owner: string; name: string; cursor?: string | null; number?: number };
        };
        const repo = data.repos.find(
          (r) => r.full_name.toLowerCase() === `${variables.owner}/${variables.name}`.toLowerCase(),
        );
        const rateLimit = {
          remaining: 4999,
          resetAt: new Date(Date.now() + 3_600_000).toISOString(),
        };
        if (!repo) return send(200, { data: { rateLimit, repository: null } });
        if (query.includes("query OnePr")) {
          const one = repo.prs.find((x) => x.number === variables.number) ?? null;
          return send(200, { data: { rateLimit, repository: { pullRequest: one } } });
        }
        const start = variables.cursor ? Number(variables.cursor) : 0;
        const nodes = repo.prs.slice(start, start + pageSize);
        const end = start + nodes.length;
        return send(200, {
          data: {
            rateLimit,
            repository: {
              pullRequests: {
                pageInfo: { hasNextPage: end < repo.prs.length, endCursor: String(end) },
                nodes,
              },
            },
          },
        });
      }
      send(404, { message: "Not Found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    data,
    calls,
    get rateLimitNext() {
      return state.rateLimitNext;
    },
    set rateLimitNext(n: number) {
      state.rateLimitNext = n;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
