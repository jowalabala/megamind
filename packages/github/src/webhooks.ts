// GitHub webhooks. Deliveries are verified, then reduced to pointers ("sync PR 12 of
// acme/api"); the worker fetches current state from GitHub. Payloads are never stored.
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    "utf8",
  );
  const given = Buffer.from(header, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface SyncPrJob {
  tenantId: string;
  connectionId: string;
  installationId: string;
  repoId: number;
  fullName: string;
  number: number;
}

export type WebhookPlan =
  | { kind: "ignore"; reason: string }
  | { kind: "sync_prs"; prs: { repoId: number; fullName: string; number: number }[] }
  | { kind: "installation_status"; status: "active" | "suspended" | "removed" }
  | { kind: "backfill_repos"; repos: { id: number; fullName: string }[] };

type Repo = { id: number; full_name: string };
interface Payload {
  action?: string;
  installation?: { id: number };
  repository?: Repo;
  number?: number;
  pull_request?: { number: number };
  check_suite?: { pull_requests?: { number: number }[] };
  repositories_added?: Repo[];
}

/** Which installation a delivery belongs to (as a string, the connection's external id). */
export function installationOf(payload: unknown): string | null {
  const id = (payload as Payload)?.installation?.id;
  return typeof id === "number" && Number.isSafeInteger(id) ? String(id) : null;
}

export function planWebhook(event: string, payload: unknown): WebhookPlan {
  const p = payload as Payload;
  const repo = p.repository;
  const one = (number: number | undefined): WebhookPlan =>
    repo && typeof number === "number"
      ? { kind: "sync_prs", prs: [{ repoId: repo.id, fullName: repo.full_name, number }] }
      : { kind: "ignore", reason: "missing repository or number" };

  switch (event) {
    case "pull_request":
      return one(p.pull_request?.number ?? p.number);
    case "pull_request_review":
    case "pull_request_review_comment":
      return one(p.pull_request?.number);
    case "check_suite": {
      // CI finished: refresh the PRs it ran for (their ci_state changes).
      const prs = (p.check_suite?.pull_requests ?? []).slice(0, 20);
      if (!repo || p.action !== "completed" || prs.length === 0) {
        return { kind: "ignore", reason: "no pull requests" };
      }
      return {
        kind: "sync_prs",
        prs: prs.map((x) => ({ repoId: repo.id, fullName: repo.full_name, number: x.number })),
      };
    }
    case "installation":
      if (p.action === "deleted") return { kind: "installation_status", status: "removed" };
      if (p.action === "suspend") return { kind: "installation_status", status: "suspended" };
      if (p.action === "unsuspend") return { kind: "installation_status", status: "active" };
      return { kind: "ignore", reason: `installation.${p.action}` };
    case "installation_repositories":
      if (p.action === "added" && p.repositories_added?.length) {
        return {
          kind: "backfill_repos",
          repos: p.repositories_added.map((r) => ({ id: r.id, fullName: r.full_name })),
        };
      }
      return { kind: "ignore", reason: `installation_repositories.${p.action}` };
    default:
      return { kind: "ignore", reason: `event ${event}` };
  }
}
