// The AWS adapters against recorded fake clients: what they send, and how they react.
import { describe, expect, it } from "vitest";
import {
  athenaLake,
  firehoseSink,
  provisionTenantLake,
  ROUTE_NAMESPACE_FIELD,
  ROUTE_TABLE_FIELD,
  type LakeProvisionConfig,
} from "../src/aws/index.ts";
import { LAKE_TABLES, tenantNamespace, type OutboxRecord } from "../src/index.ts";

const TENANT = "0f8b6a52-3c1d-4e2f-9a7b-1c2d3e4f5a6b";
const OTHER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const MEMBER = "11111111-2222-4333-8444-555555555555";
const HEX = TENANT.replace(/-/g, "");

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

function recorder(respond: (name: string, input: Record<string, unknown>) => unknown) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  return {
    calls,
    names: () => calls.map((c) => c.name),
    async send(command: unknown) {
      const c = command as Cmd;
      const name = c.constructor.name.replace(/Command$/, "");
      calls.push({ name, input: c.input });
      return respond(name, c.input);
    },
  };
}

const named = (name: string, message = name) => Object.assign(new Error(message), { name });

const record = (id: number, row: Record<string, unknown> = {}): OutboxRecord => ({
  id,
  table: "actions",
  eventId: `e${id}`,
  row: { event_id: `e${id}`, ...row },
});

describe("firehoseSink", () => {
  it("tags every record with its tenant namespace and table, in batches of at most 500", async () => {
    const fh = recorder(() => ({ RequestResponses: [] }));
    const sink = firehoseSink({ streamName: "mm-dev-lake", client: fh });
    const records = Array.from({ length: 1201 }, (_, i) => record(i));
    expect(await sink.put(TENANT, records)).toEqual({ failedIds: [] });
    const batches = fh.calls.map((c) => (c.input.Records as unknown[]).length);
    expect(batches).toEqual([500, 500, 201]);
    const first = JSON.parse(
      Buffer.from((fh.calls[0]!.input.Records as { Data: Uint8Array }[])[0]!.Data).toString(),
    );
    expect(first).toMatchObject({
      event_id: "e0",
      [ROUTE_NAMESPACE_FIELD]: `t_${HEX}`,
      [ROUTE_TABLE_FIELD]: "actions",
    });
    expect(fh.calls[0]!.input.DeliveryStreamName).toBe("mm-dev-lake");
  });

  it("reports records Firehose rejected, and whole batches when the call fails", async () => {
    let call = 0;
    const fh = recorder(() => {
      call++;
      if (call === 1) {
        return { RequestResponses: [{ RecordId: "a" }, { ErrorCode: "ServiceUnavailable" }] };
      }
      throw new Error("throttled");
    });
    const sink = firehoseSink({ streamName: "s", client: fh });
    // Records sized so the second call gets its own batch.
    const big = "x".repeat(700 * 1024);
    const res = await sink.put(TENANT, [
      record(1),
      record(2),
      record(3, { summary: big }),
      record(4, { summary: big }),
      record(5, { summary: big }),
      record(6, { summary: big }),
      record(7, { summary: big }),
      record(8, { summary: big }),
    ]);
    expect(res.failedIds.sort()).toEqual([2, 8]);
  });

  it("never sends a record over Firehose's 1,000 KiB limit", async () => {
    const fh = recorder(() => ({ RequestResponses: [{}] }));
    const sink = firehoseSink({ streamName: "s", client: fh });
    const res = await sink.put(TENANT, [
      record(1, { summary: "x".repeat(1100 * 1024) }),
      record(2),
    ]);
    expect(res.failedIds).toEqual([1]);
    expect((fh.calls[0]!.input.Records as unknown[]).length).toBe(1);
  });
});

describe("athenaLake", () => {
  function setup(results: Record<string, string>[][] = [], state = "SUCCEEDED") {
    const sts = recorder(() => ({
      Credentials: {
        AccessKeyId: "AKIDEXAMPLE",
        SecretAccessKey: "secret",
        SessionToken: "token",
        Expiration: new Date(Date.now() + 900_000),
      },
    }));
    let page = 0;
    const athena = recorder((name) => {
      if (name === "StartQueryExecution") return { QueryExecutionId: "q1" };
      if (name === "GetQueryExecution") {
        return { QueryExecution: { Status: { State: state, StateChangeReason: "boom" } } };
      }
      const rows = results[page] ?? [];
      const columns = Object.keys(rows[0] ?? { t: "", n: "" });
      const header = page === 0 ? [{ Data: columns.map((c) => ({ VarCharValue: c })) }] : [];
      page++;
      return {
        NextToken: page < results.length ? `p${page}` : undefined,
        ResultSet: {
          ResultSetMetadata: { ColumnInfo: columns.map((Name) => ({ Name })) },
          Rows: [
            ...header,
            ...rows.map((r) => ({ Data: columns.map((c) => ({ VarCharValue: r[c] })) })),
          ],
        },
      };
    });
    const lake = athenaLake({
      stage: "dev",
      region: "us-east-1",
      accountId: "123456789012",
      tableBucketName: "mastermind-dev-lake",
      sts,
      athenaFor: () => athena,
      pollIntervalMs: 1,
    });
    return { sts, athena, lake };
  }

  it("runs as the tenant's own role, in its workgroup, catalog and namespace", async () => {
    const { sts, athena, lake } = setup([
      [
        { t: "actions", n: "5" },
        { t: "tasks", n: "2" },
      ],
    ]);
    expect(await lake.tableCounts(TENANT)).toEqual({
      actions: 5,
      tasks: 2,
      metric_observations: 0,
    });
    expect(sts.calls[0]!.input.RoleArn).toBe(
      `arn:aws:iam::123456789012:role/mastermind/dev/lake/mm-lake-dev-t-${HEX}`,
    );
    const start = athena.calls.find((c) => c.name === "StartQueryExecution")!.input;
    expect(start).toMatchObject({
      WorkGroup: `mm-dev-t-${HEX}`,
      QueryExecutionContext: {
        Catalog: "s3tablescatalog/mastermind-dev-lake",
        Database: `t_${HEX}`,
      },
    });
    // Credentials are reused for the same tenant, but never across tenants.
    await lake.tableCounts(TENANT);
    expect(sts.calls).toHaveLength(1);
    await lake.tableCounts(OTHER).catch(() => {});
    expect(sts.calls).toHaveLength(2);
  });

  it("deletes a member's rows from every table, with the id validated", async () => {
    const { athena, lake } = setup();
    await lake.deleteMemberRows(TENANT, MEMBER);
    const sqls = athena.calls
      .filter((c) => c.name === "StartQueryExecution")
      .map((c) => c.input.QueryString);
    expect(sqls).toEqual(LAKE_TABLES.map((t) => `DELETE FROM ${t} WHERE member_id = '${MEMBER}'`));
    await expect(lake.deleteMemberRows(TENANT, "x' OR '1'='1")).rejects.toThrow(/tenant id/);
  });

  it("escapes resource filters and reads paged results", async () => {
    const row = (id: string) => ({
      event_id: id,
      member_id: MEMBER,
      kind: "edit",
      summary: "Edited",
      resources: '["git:github.com/acme/api:src/a.ts"]',
      event_time: "2026-10-30 12:00:00.000 UTC",
    });
    const { athena, lake } = setup([[row("a"), row("b")], [row("c")]]);
    const rows = await lake.recentActions(TENANT, { resource: "it's_100%", limit: 1000 });
    expect(rows.map((r) => r.event_id)).toEqual(["a", "b", "c"]);
    expect(rows[0]!.resources).toEqual(["git:github.com/acme/api:src/a.ts"]);
    const q = athena.calls.find((c) => c.name === "StartQueryExecution")!.input
      .QueryString as string;
    expect(q).toContain(`LIKE '%it''s\\_100\\%%' ESCAPE '\\'`);
    expect(q).toContain("LIMIT 200");
    expect(q).toContain("PARTITION BY event_id");
  });

  it("surfaces failed queries", async () => {
    const { lake } = setup([], "FAILED");
    await expect(lake.tableCounts(TENANT)).rejects.toThrow("Athena query failed: boom");
  });
});

describe("provisionTenantLake", () => {
  const cfg: LakeProvisionConfig = {
    stage: "dev",
    region: "us-east-1",
    accountId: "123456789012",
    tableBucketArn: "arn:aws:s3tables:us-east-1:123456789012:bucket/mastermind-dev-lake",
    tableBucketName: "mastermind-dev-lake",
    resultsBucket: "mastermind-dev-athena-results",
    firehoseRoleArn: "arn:aws:iam::123456789012:role/firehose",
    trustedRoleArns: [
      "arn:aws:iam::123456789012:role/worker",
      "arn:aws:iam::123456789012:role/api",
    ],
    permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/mm-lake-boundary",
  };
  const KEY = "arn:aws:kms:us-east-1:123456789012:key/abc";
  const ROLE = `arn:aws:iam::123456789012:role/mastermind/dev/lake/mm-lake-dev-t-${HEX}`;

  function clients(existing: boolean) {
    const kms = recorder((name) => {
      if (name === "DescribeKey") {
        if (!existing) throw named("NotFoundException");
        return { KeyMetadata: { Arn: KEY } };
      }
      if (name === "CreateKey") return { KeyMetadata: { Arn: KEY } };
      return {};
    });
    const s3tables = recorder((name) => {
      if (existing && (name === "CreateNamespace" || name === "CreateTable")) {
        throw named("ConflictException");
      }
      return {};
    });
    const iam = recorder((name) => {
      if (name === "GetRole") {
        if (!existing) throw named("NoSuchEntityException");
        return { Role: { Arn: ROLE } };
      }
      if (name === "CreateRole") return { Role: { Arn: ROLE } };
      return {};
    });
    const athena = recorder((name) => {
      if (name === "GetWorkGroup" && !existing) throw named("InvalidRequestException");
      return {};
    });
    const lakeformation = recorder(() => ({}));
    return { kms, s3tables, iam, athena, lakeformation };
  }

  it("creates the key, namespace, encrypted tables, role, workgroup and grants", async () => {
    const c = clients(false);
    const res = await provisionTenantLake(cfg, c, TENANT);
    expect(res).toEqual({
      namespace: `t_${HEX}`,
      keyArn: KEY,
      roleArn: ROLE,
      workgroup: `mm-dev-t-${HEX}`,
      tables: [...LAKE_TABLES],
    });

    expect(c.kms.names()).toEqual(["DescribeKey", "CreateKey", "EnableKeyRotation", "CreateAlias"]);
    const policy = JSON.parse(c.kms.calls[1]!.input.Policy as string);
    expect(policy.Statement.map((s: { Sid: string }) => s.Sid)).toEqual([
      "AccountIamControl",
      "S3TablesMaintenance",
    ]);
    expect(c.kms.calls[3]!.input.AliasName).toBe(`alias/mastermind/dev/lake/t-${HEX}`);

    const tables = c.s3tables.calls.filter((x) => x.name === "CreateTable");
    expect(tables.map((t) => t.input.name)).toEqual([...LAKE_TABLES]);
    for (const t of tables) {
      expect(t.input.namespace).toBe(tenantNamespace(TENANT));
      expect(t.input.encryptionConfiguration).toEqual({ sseAlgorithm: "aws:kms", kmsKeyArn: KEY });
      const meta = t.input.metadata as {
        iceberg: {
          schema: { fields: { id: number; name: string }[] };
          partitionSpec: { fields: { sourceId: number; transform: string }[] };
        };
      };
      const eventTime = meta.iceberg.schema.fields.find((f) => f.name === "event_time")!;
      expect(meta.iceberg.partitionSpec.fields).toEqual([
        { sourceId: eventTime.id, transform: "day", name: "event_day", fieldId: 1000 },
      ]);
    }
    const snapshots = c.s3tables.calls.filter(
      (x) =>
        x.name === "PutTableMaintenanceConfiguration" &&
        x.input.type === "icebergSnapshotManagement",
    );
    expect(snapshots).toHaveLength(LAKE_TABLES.length);
    expect(snapshots[0]!.input.value).toMatchObject({
      settings: { icebergSnapshotManagement: { maxSnapshotAgeHours: 168, minSnapshotsToKeep: 1 } },
    });

    const role = c.iam.calls.find((x) => x.name === "CreateRole")!.input;
    expect(role).toMatchObject({
      Path: "/mastermind/dev/lake/",
      PermissionsBoundary: cfg.permissionsBoundaryArn,
    });
    expect(JSON.parse(role.AssumeRolePolicyDocument as string).Statement[0].Principal.AWS).toEqual(
      cfg.trustedRoleArns,
    );
    const inline = JSON.stringify(c.iam.calls.find((x) => x.name === "PutRolePolicy")!.input);
    // Scoped to this tenant only.
    expect(inline).toContain(`t_${HEX}`);
    expect(inline).toContain(`tenant=${TENANT}/`);
    expect(inline).not.toContain(OTHER.replace(/-/g, ""));

    const wg = c.athena.calls.find((x) => x.name === "CreateWorkGroup")!.input;
    expect(wg).toMatchObject({
      Name: `mm-dev-t-${HEX}`,
      Configuration: {
        EnforceWorkGroupConfiguration: true,
        ResultConfiguration: {
          OutputLocation: `s3://mastermind-dev-athena-results/tenant=${TENANT}/`,
          EncryptionConfiguration: { EncryptionOption: "SSE_KMS", KmsKey: KEY },
        },
      },
    });

    const grants = c.lakeformation.calls.map((g) => ({
      who: (g.input.Principal as { DataLakePrincipalIdentifier: string })
        .DataLakePrincipalIdentifier,
      perms: g.input.Permissions,
      resource: g.input.Resource,
    }));
    expect(grants).toHaveLength(4);
    const catalogId = "123456789012:s3tablescatalog/mastermind-dev-lake";
    expect(grants[1]).toEqual({
      who: cfg.firehoseRoleArn,
      perms: ["ALL"],
      resource: { Table: { CatalogId: catalogId, DatabaseName: `t_${HEX}`, TableWildcard: {} } },
    });
    expect(grants[3]).toMatchObject({
      who: ROLE,
      perms: ["SELECT", "DESCRIBE", "INSERT", "DELETE"],
    });
  });

  it("is safe to run again: nothing is created twice, settings are re-applied", async () => {
    const c = clients(true);
    await provisionTenantLake(cfg, c, TENANT);
    const all = [c.kms, c.s3tables, c.iam, c.athena].flatMap((x) => x.names());
    expect(all.filter((n) => /^Create(Key|Alias|Role|WorkGroup)$/.test(n))).toEqual([]);
    expect(c.iam.names()).toContain("PutRolePolicy");
    expect(c.lakeformation.calls).toHaveLength(4);
  });

  it("retries Lake Formation grants while a new role propagates", async () => {
    const c = clients(false);
    let failures = 2;
    c.lakeformation.send = (async () => {
      if (failures-- > 0) throw named("InvalidInputException", "Invalid principal");
      return {};
    }) as typeof c.lakeformation.send;
    await expect(provisionTenantLake(cfg, c, TENANT)).resolves.toBeDefined();
  }, 20_000);
});
