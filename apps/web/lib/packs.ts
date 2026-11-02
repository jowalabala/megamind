// Server-side helpers for the pack editor and CSV uploads.
import { tenantRedactors } from "@mm/ingest/redaction";
import { tenantPackLoader } from "@mm/packs";
import { db } from "./db";

const g = globalThis as unknown as { __mmRedactors?: ReturnType<typeof tenantRedactors> };

/** Redacts uploaded text (CSV titles) the same way ingest does. */
export function redactorFor(tenantId: string) {
  if (!g.__mmRedactors) {
    const secret = process.env.MM_PSEUDONYM_SECRET;
    if (!secret) throw new Error("MM_PSEUDONYM_SECRET is not set.");
    g.__mmRedactors = tenantRedactors({ db: db(), pseudonymSecret: secret });
  }
  return g.__mmRedactors(tenantId);
}

/** Uncached, so an upload right after an edit sees the new metrics. */
export const freshPacks = () => tenantPackLoader(db(), { ttlMs: 0 });
