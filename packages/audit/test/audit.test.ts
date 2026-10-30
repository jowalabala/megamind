import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createDb, type MasterMindDb } from "@mm/db";
import { adminQuery, startTestDatabase, type TestDatabase } from "@mm/db/testing";
import { appendAuditEvent, canonicalJson, verifyAuditChain } from "../src/index.ts";

let env: TestDatabase;
let db: MasterMindDb;
let A: string;
let B: string;

const provision = (slug: string) =>
  db.system.provisionTenant(
    {
      name: slug,
      slug,
      workosOrgId: null,
      admin: { workosUserId: `u_${slug}`, email: `a@${slug}.test`, displayName: null },
    },
    // The tenant and its "tenant.created" event commit together.
    (tx, t) =>
      appendAuditEvent(tx, t.tenantId, {
        actorType: "member",
        actorId: t.adminMemberId,
        action: "tenant.created",
        targetType: "tenant",
        targetId: t.tenantId,
      }).then(() => undefined),
  );

beforeAll(async () => {
  env = await startTestDatabase();
  db = createDb({ connectionString: env.appUrl, max: 5 });
  A = (await provision("alpha")).tenantId;
  B = (await provision("bravo")).tenantId;
});
afterAll(async () => {
  await db?.close();
  await env?.stop();
});

describe("canonicalJson", () => {
  it("sorts keys at every level and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}',
    );
  });
  it("rejects NaN", () => {
    expect(() => canonicalJson({ x: NaN })).toThrow();
  });
});

describe("append and verify", () => {
  it("builds a separate gapless chain per tenant", async () => {
    await db.withTenant(A, async (tx) => {
      await appendAuditEvent(tx, A, {
        actorType: "system",
        actorId: null,
        action: "member.invited",
        payload: { role: "member", nested: { b: 2, a: 1 } },
      });
      await appendAuditEvent(tx, A, {
        actorType: "agent",
        actorId: "agent_1",
        action: "task.logged",
      });
    });
    const a = await db.withTenant(A, (tx) => verifyAuditChain(tx, A));
    const b = await db.withTenant(B, (tx) => verifyAuditChain(tx, B));
    expect(a).toMatchObject({ ok: true, count: 3 });
    expect(b).toMatchObject({ ok: true, count: 1 });
  });

  it("keeps the chain linear under 25 concurrent writers", async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        db.withTenant(B, (tx) =>
          appendAuditEvent(tx, B, {
            actorType: "system",
            actorId: null,
            action: "load.test",
            payload: { i },
          }),
        ),
      ),
    );
    const { rows } = await adminQuery<{ seq: string }>(
      env.adminUrl,
      "SELECT seq FROM audit_events WHERE tenant_id = $1 ORDER BY seq",
      [B],
    );
    expect(rows.map((r) => Number(r.seq))).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
    expect(await db.withTenant(B, (tx) => verifyAuditChain(tx, B))).toMatchObject({
      ok: true,
      count: 26,
    });
  });

  it("rolls the event back with the transaction it belongs to", async () => {
    await expect(
      db.withTenant(A, async (tx) => {
        await appendAuditEvent(tx, A, {
          actorType: "system",
          actorId: null,
          action: "doomed.change",
        });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await db.withTenant(A, (tx) => verifyAuditChain(tx, A))).toMatchObject({
      ok: true,
      count: 3,
    });
  });
});

describe("immutability and tamper evidence", () => {
  it("mm_app cannot update or delete audit events", async () => {
    const client = new pg.Client({ connectionString: env.appUrl });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
      await expect(client.query("UPDATE audit_events SET action = 'x.y'")).rejects.toMatchObject({
        code: "42501",
      });
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
      await expect(client.query("DELETE FROM audit_events")).rejects.toMatchObject({
        code: "42501",
      });
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  });

  it("even the owner is blocked by the append-only trigger", async () => {
    await expect(
      adminQuery(env.adminUrl, "DELETE FROM audit_events WHERE tenant_id = $1", [A]),
    ).rejects.toThrow(/append-only/);
  });

  it("detects an edited event", async () => {
    // Simulate an attacker with superuser access who disables the trigger.
    await adminQuery(
      env.adminUrl,
      `ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete;
       UPDATE audit_events SET payload = '{"role":"admin"}' WHERE tenant_id = '${A}' AND seq = 2;
       ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete;`,
    );
    expect(await db.withTenant(A, (tx) => verifyAuditChain(tx, A))).toEqual({
      ok: false,
      brokenAtSeq: 2,
      reason: "event contents do not match its hash",
    });
  });

  it("detects a deleted tail event", async () => {
    await adminQuery(
      env.adminUrl,
      `ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete;
       DELETE FROM audit_events WHERE tenant_id = '${B}' AND seq = 26;
       ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete;`,
    );
    expect(await db.withTenant(B, (tx) => verifyAuditChain(tx, B))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/truncated/),
    });
  });
});
