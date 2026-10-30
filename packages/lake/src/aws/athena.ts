// Tenant-scoped lake queries through Athena.
//
// Every call assumes that tenant's own IAM role and runs in that tenant's workgroup. The
// role can only read its own namespace (Lake Formation grants) and its own KMS key, and the
// workgroup writes results under the tenant's prefix, encrypted with that key. So even a
// bug in the SQL here can't read another tenant's data.
//
// Only fixed query templates run. Values are validated (ids are UUIDs) or escaped before
// they are inlined: Athena parameters are not supported for DELETE.
import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
} from "@aws-sdk/client-athena";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { assertTenantId } from "@mm/db";
import { s3TablesCatalog, tenantNamespace, tenantRoleArn, tenantWorkgroup } from "../naming.ts";
import { LAKE_TABLES } from "../tables.ts";
import type { ErasureSubject, LakeActionRow, LakeAdmin, LakeCounts } from "../types.ts";

type Send = { send(command: unknown): Promise<unknown> };

export interface AthenaLakeOptions {
  stage: string;
  region: string;
  accountId: string;
  tableBucketName: string;
  sts?: Send;
  /** Builds an Athena client for assumed-role credentials. Overridden in tests. */
  athenaFor?: (credentials: Credentials) => Send;
  pollIntervalMs?: number;
  timeoutMs?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}

export class LakeQueryError extends Error {
  override name = "LakeQueryError";
}

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;
const likeContains = (s: string) => sqlString(`%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);

function uuidLiteral(id: string): string {
  assertTenantId(id); // same UUID check
  return sqlString(id);
}

const ACTOR_KEY_RE = /^[a-z]+:[A-Za-z0-9_-]{1,64}$/;

/** WHERE clause matching one person's rows. Every value is validated before inlining. */
function subjectFilter(s: ErasureSubject): string {
  const keys = s.actorKeys.map((k) => {
    if (!ACTOR_KEY_RE.test(k)) throw new LakeQueryError(`Invalid actor key`);
    return sqlString(k);
  });
  const member = `member_id = ${uuidLiteral(s.memberId)}`;
  return keys.length ? `(${member} OR actor_key IN (${keys.join(", ")}))` : member;
}

export function athenaLake(options: AthenaLakeOptions): LakeAdmin & {
  query(tenantId: string, sql: string): Promise<Record<string, string | null>[]>;
} {
  const sts = options.sts ?? new STSClient({ region: options.region });
  const athenaFor =
    options.athenaFor ??
    ((c: Credentials) => new AthenaClient({ region: options.region, credentials: c }));
  const cache = new Map<string, { creds: Credentials; client: Send }>();
  const poll = options.pollIntervalMs ?? 500;
  const timeout = options.timeoutMs ?? 120_000;

  async function clientFor(tenantId: string): Promise<Send> {
    const hit = cache.get(tenantId);
    if (hit && hit.creds.expiration.getTime() - Date.now() > 60_000) return hit.client;
    const res = (await sts.send(
      new AssumeRoleCommand({
        RoleArn: tenantRoleArn(options.accountId, options.stage, tenantId),
        RoleSessionName: "mm-lake-query",
        DurationSeconds: 900,
      }),
    )) as {
      Credentials?: {
        AccessKeyId?: string;
        SecretAccessKey?: string;
        SessionToken?: string;
        Expiration?: Date;
      };
    };
    const c = res.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
      throw new LakeQueryError("AssumeRole returned no credentials");
    }
    const creds: Credentials = {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration ?? new Date(Date.now() + 900_000),
    };
    const client = athenaFor(creds);
    cache.set(tenantId, { creds, client });
    return client;
  }

  async function query(tenantId: string, sql: string): Promise<Record<string, string | null>[]> {
    const athena = await clientFor(tenantId);
    const started = (await athena.send(
      new StartQueryExecutionCommand({
        QueryString: sql,
        WorkGroup: tenantWorkgroup(options.stage, tenantId),
        QueryExecutionContext: {
          Catalog: s3TablesCatalog(options.tableBucketName),
          Database: tenantNamespace(tenantId),
        },
      }),
    )) as { QueryExecutionId?: string };
    const id = started.QueryExecutionId;
    if (!id) throw new LakeQueryError("Athena returned no query id");

    const deadline = Date.now() + timeout;
    for (;;) {
      const res = (await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }))) as {
        QueryExecution?: { Status?: { State?: string; StateChangeReason?: string } };
      };
      const state = res.QueryExecution?.Status?.State;
      if (state === "SUCCEEDED") break;
      if (state === "FAILED" || state === "CANCELLED") {
        throw new LakeQueryError(
          `Athena query ${state.toLowerCase()}: ${res.QueryExecution?.Status?.StateChangeReason ?? "no reason"}`,
        );
      }
      if (Date.now() > deadline) throw new LakeQueryError(`Athena query ${id} timed out`);
      await new Promise((r) => setTimeout(r, poll));
    }

    const rows: Record<string, string | null>[] = [];
    let columns: string[] | null = null;
    let next: string | undefined;
    let first = true;
    do {
      const page = (await athena.send(
        new GetQueryResultsCommand({ QueryExecutionId: id, NextToken: next }),
      )) as {
        NextToken?: string;
        ResultSet?: {
          ResultSetMetadata?: { ColumnInfo?: { Name?: string }[] };
          Rows?: { Data?: { VarCharValue?: string }[] }[];
        };
      };
      columns ??= (page.ResultSet?.ResultSetMetadata?.ColumnInfo ?? []).map((c) => c.Name ?? "");
      const data = page.ResultSet?.Rows ?? [];
      // For SELECT, the first row of the first page repeats the column names.
      for (const [i, r] of data.entries()) {
        if (first && i === 0 && columns.length && r.Data?.[0]?.VarCharValue === columns[0])
          continue;
        rows.push(
          Object.fromEntries(columns.map((c, j) => [c, r.Data?.[j]?.VarCharValue ?? null])),
        );
      }
      first = false;
      next = page.NextToken;
    } while (next);
    return rows;
  }

  const countsFrom = (rows: Record<string, string | null>[]): LakeCounts => {
    const out = Object.fromEntries(LAKE_TABLES.map((t) => [t, 0])) as LakeCounts;
    for (const r of rows) out[r.t as keyof LakeCounts] = Number(r.n ?? 0);
    return out;
  };

  return {
    query,

    async tableCounts(tenantId) {
      const sql = LAKE_TABLES.map(
        (t) => `SELECT '${t}' AS t, count(DISTINCT event_id) AS n FROM ${t}`,
      ).join(" UNION ALL ");
      return countsFrom(await query(tenantId, sql));
    },

    async memberRowCounts(tenantId, subject) {
      const where = subjectFilter(subject);
      const sql = LAKE_TABLES.map(
        (t) => `SELECT '${t}' AS t, count(*) AS n FROM ${t} WHERE ${where}`,
      ).join(" UNION ALL ");
      return countsFrom(await query(tenantId, sql));
    },

    async deleteMemberRows(tenantId, subject) {
      const where = subjectFilter(subject);
      for (const t of LAKE_TABLES) {
        await query(tenantId, `DELETE FROM ${t} WHERE ${where}`);
        options.log?.("lake.member_rows_deleted", { tenantId, table: t });
      }
    },

    async scan(tenantId, table, range = {}) {
      if (!LAKE_TABLES.includes(table)) throw new LakeQueryError(`Unknown table ${table}`);
      const ts = (d: Date) => `from_iso8601_timestamp(${sqlString(d.toISOString())})`;
      const where = [
        range.from ? `event_time >= ${ts(range.from)}` : null,
        range.to ? `event_time < ${ts(range.to)}` : null,
      ].filter(Boolean);
      return query(
        tenantId,
        `SELECT * FROM (
           SELECT *, row_number() OVER (PARTITION BY event_id ORDER BY ingested_at) AS rn
             FROM ${table} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ) WHERE rn = 1`,
      );
    },

    async recentActions(tenantId, opts = {}) {
      const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20), 1), 200);
      const filter = opts.resource
        ? `WHERE any_match(CAST(json_parse(resources) AS array(varchar)), r -> r LIKE ${likeContains(opts.resource)} ESCAPE '\\')`
        : "";
      const rows = await query(
        tenantId,
        `SELECT event_id, member_id, kind, summary, resources, event_time FROM (
           SELECT *, row_number() OVER (PARTITION BY event_id ORDER BY ingested_at) AS rn
             FROM actions ${filter}
         ) WHERE rn = 1 ORDER BY event_time DESC LIMIT ${limit}`,
      );
      return rows.map((r): LakeActionRow => ({
        event_id: r.event_id ?? "",
        member_id: r.member_id ?? "",
        kind: r.kind ?? "",
        summary: r.summary ?? "",
        resources: JSON.parse(r.resources ?? "[]") as string[],
        event_time: r.event_time ?? "",
      }));
    },
  };
}
