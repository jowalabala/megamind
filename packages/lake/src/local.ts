// A stand-in lake for development and tests: newline-delimited JSON per tenant and table,
// in memory or under a git-ignored directory. Same interfaces as the AWS lake, including
// at-least-once delivery (readers de-duplicate on event_id) and member deletes.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tenantNamespace } from "./naming.ts";
import { LAKE_TABLES, type LakeTableName } from "./tables.ts";
import type { ErasureSubject, LakeActionRow, LakeAdmin, LakeCounts, LakeSink } from "./types.ts";

type Row = Record<string, unknown>;

interface Storage {
  append(ns: string, table: LakeTableName, rows: Row[]): Promise<void>;
  read(ns: string, table: LakeTableName): Promise<Row[]>;
  write(ns: string, table: LakeTableName, rows: Row[]): Promise<void>;
}

function memoryStorage(): Storage {
  const data = new Map<string, Row[]>();
  const key = (ns: string, t: string) => `${ns}/${t}`;
  return {
    async append(ns, t, rows) {
      data.set(key(ns, t), [...(data.get(key(ns, t)) ?? []), ...structuredClone(rows)]);
    },
    async read(ns, t) {
      return structuredClone(data.get(key(ns, t)) ?? []);
    },
    async write(ns, t, rows) {
      data.set(key(ns, t), structuredClone(rows));
    },
  };
}

function fileStorage(dir: string): Storage {
  const root = resolve(dir);
  const path = (ns: string, t: string) => join(root, ns, `${t}.ndjson`);
  return {
    async append(ns, t, rows) {
      await mkdir(join(root, ns), { recursive: true });
      await appendFile(path(ns, t), rows.map((r) => JSON.stringify(r) + "\n").join(""), {
        mode: 0o600,
      });
    },
    async read(ns, t) {
      try {
        const text = await readFile(path(ns, t), "utf8");
        return text
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Row);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
    },
    async write(ns, t, rows) {
      await mkdir(join(root, ns), { recursive: true });
      await writeFile(path(ns, t), rows.map((r) => JSON.stringify(r) + "\n").join(""), {
        mode: 0o600,
      });
    },
  };
}

/** First copy of each event wins, like the Athena queries. */
function dedupe(rows: Row[]): Row[] {
  const seen = new Set<unknown>();
  return rows.filter((r) => (seen.has(r.event_id) ? false : (seen.add(r.event_id), true)));
}

export type LocalLake = LakeSink &
  LakeAdmin & { rows(tenantId: string, table: LakeTableName): Promise<Row[]> };

const belongsTo = (s: ErasureSubject) => (r: Row) =>
  r.member_id === s.memberId || s.actorKeys.includes(String(r.actor_key));

/** In memory when `dir` is omitted. */
export function localLake(options: { dir?: string } = {}): LocalLake {
  const storage = options.dir ? fileStorage(options.dir) : memoryStorage();

  async function counts(tenantId: string, filter: (r: Row) => boolean): Promise<LakeCounts> {
    const ns = tenantNamespace(tenantId);
    const out = {} as LakeCounts;
    for (const t of LAKE_TABLES) out[t] = dedupe(await storage.read(ns, t)).filter(filter).length;
    return out;
  }

  return {
    async put(tenantId, records) {
      const ns = tenantNamespace(tenantId);
      for (const table of LAKE_TABLES) {
        const rows = records.filter((r) => r.table === table).map((r) => r.row);
        if (rows.length) await storage.append(ns, table, rows);
      }
      return { failedIds: [] };
    },
    tableCounts: (tenantId) => counts(tenantId, () => true),
    memberRowCounts: (tenantId, subject) => counts(tenantId, belongsTo(subject)),
    async deleteMemberRows(tenantId, subject) {
      const ns = tenantNamespace(tenantId);
      const mine = belongsTo(subject);
      for (const t of LAKE_TABLES) {
        const rows = await storage.read(ns, t);
        await storage.write(
          ns,
          t,
          rows.filter((r) => !mine(r)),
        );
      }
    },
    async rows(tenantId, table) {
      return dedupe(await storage.read(tenantNamespace(tenantId), table));
    },
    async scan(tenantId, table, range = {}) {
      return dedupe(await storage.read(tenantNamespace(tenantId), table)).filter((r) => {
        const t = Date.parse(String(r.event_time));
        return (!range.from || t >= range.from.getTime()) && (!range.to || t < range.to.getTime());
      });
    },
    async recentActions(tenantId, opts = {}) {
      const rows = dedupe(await storage.read(tenantNamespace(tenantId), "actions"))
        .map((r): LakeActionRow => ({
          event_id: String(r.event_id),
          member_id: String(r.member_id),
          kind: String(r.kind),
          summary: String(r.summary),
          resources: JSON.parse(String(r.resources)) as string[],
          event_time: String(r.event_time),
        }))
        .filter((r) => !opts.resource || r.resources.some((x) => x.includes(opts.resource!)))
        .sort((a, b) => b.event_time.localeCompare(a.event_time));
      return rows.slice(0, opts.limit ?? 20);
    },
  };
}
