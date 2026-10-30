// Replaces known people (the tenant's members) with stable pseudonyms such as
// [PERSON:3fa2c19b]. The same person always gets the same pseudonym within a tenant,
// so analysis can still group work by author without knowing who it is.
import { createHmac } from "node:crypto";
import type { Detection, Detector } from "./types.ts";

export interface DirectoryEntry {
  /** Stable id, e.g. the member id. Never printed. */
  id: string;
  emails?: string[];
  /** Full names (two or more words). Single first names are ignored: too many false matches. */
  names?: string[];
  /** Handles such as GitHub logins. Matched only when written as @handle. */
  handles?: string[];
}

export interface DirectoryOptions {
  /** Per-tenant secret. Without it, pseudonyms could be reversed by hashing guessed ids. */
  key: string | Buffer;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function pseudonym(key: string | Buffer, id: string): string {
  return createHmac("sha256", key).update(id).digest("hex").slice(0, 8);
}

export function createDirectoryDetector(
  entries: DirectoryEntry[],
  options: DirectoryOptions,
): Detector {
  const byTerm = new Map<string, string>();
  const add = (term: string, id: string) => {
    const t = term.trim().toLowerCase();
    if (t && !byTerm.has(t)) byTerm.set(t, id);
  };
  for (const e of entries) {
    for (const email of e.emails ?? []) add(email, e.id);
    for (const name of e.names ?? []) {
      if (name.trim().split(/\s+/).length >= 2) add(name.replace(/\s+/g, " "), e.id);
    }
    for (const h of e.handles ?? []) if (h.length >= 2) add("@" + h.replace(/^@/, ""), e.id);
  }
  if (byTerm.size === 0) return { name: "directory", detect: () => [] };

  // Longest first, so "Dana Levi-Cohen" wins over "Dana Levi".
  const alternation = [...byTerm.keys()]
    .sort((a, b) => b.length - a.length)
    .map((t) => escapeRe(t).replace(/ /g, "\\s+"))
    .join("|");
  const re = new RegExp(`(?<![\\p{L}\\p{N}_.@-])(?:${alternation})(?![\\p{L}\\p{N}_-])`, "giu");
  const tag = new Map<string, string>();

  return {
    name: "directory",
    detect(text) {
      const out: Detection[] = [];
      for (const m of text.matchAll(re)) {
        const id = byTerm.get(m[0].replace(/\s+/g, " ").toLowerCase());
        if (!id) continue;
        let p = tag.get(id);
        if (!p) tag.set(id, (p = pseudonym(options.key, id)));
        out.push({
          start: m.index,
          end: m.index + m[0].length,
          category: "pii",
          label: "person",
          replacement: `[PERSON:${p}]`,
        });
      }
      return out;
    },
  };
}
