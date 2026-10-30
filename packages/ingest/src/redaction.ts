// One redactor per tenant: the shared rules plus that tenant's member directory, with
// pseudonyms keyed per tenant so the same person can't be linked across tenants.
import { createHmac } from "node:crypto";
import { members, type MasterMindDb } from "@mm/db";
import {
  createDirectoryDetector,
  createRedactor,
  type AsyncDetector,
  type Redactor,
} from "@mm/privacy";

export interface TenantRedactorsOptions {
  db: MasterMindDb;
  /** Server-side secret (Secrets Manager). Per-tenant pseudonym keys are derived from it. */
  pseudonymSecret: string;
  /** Optional external PII detector, e.g. AWS Comprehend. */
  external?: AsyncDetector;
  /** How long a tenant's directory is cached. */
  ttlMs?: number;
}

export type RedactorFor = (tenantId: string) => Promise<Redactor>;

export function tenantRedactors(options: TenantRedactorsOptions): RedactorFor {
  if (options.pseudonymSecret.length < 32) {
    throw new Error("The pseudonym secret must be at least 32 characters.");
  }
  const ttl = options.ttlMs ?? 60_000;
  const cache = new Map<string, { at: number; redactor: Redactor }>();

  return async (tenantId) => {
    const hit = cache.get(tenantId);
    if (hit && Date.now() - hit.at < ttl) return hit.redactor;
    const people = await options.db.withTenant(tenantId, (tx) =>
      tx
        .select({ id: members.id, email: members.email, displayName: members.displayName })
        .from(members),
    );
    const key = createHmac("sha256", options.pseudonymSecret).update(tenantId).digest();
    const directory = createDirectoryDetector(
      people.map((p) => ({
        id: p.id,
        emails: [p.email],
        names: p.displayName ? [p.displayName] : [],
      })),
      { key },
    );
    const redactor = createRedactor({ detectors: [directory], external: options.external });
    cache.set(tenantId, { at: Date.now(), redactor });
    return redactor;
  };
}
