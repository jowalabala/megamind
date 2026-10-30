import { describe, expect, it } from "vitest";
import { clientMessage, signGatewayToken, verifyGatewayToken } from "../src/index.ts";

const SECRET = "g".repeat(40);
const claims = {
  tenantId: "0f8b6a52-3c1d-4e2f-9a7b-1c2d3e4f5a6b",
  agentId: "11111111-2222-4333-8444-555555555555",
  memberId: "66666666-7777-4888-9999-000000000000",
};

describe("gateway tokens", () => {
  it("round-trip, and expire after five minutes", () => {
    const { token, expiresAt } = signGatewayToken(SECRET, claims, 1_000);
    expect(expiresAt.getTime()).toBe(1_000 + 5 * 60_000);
    expect(verifyGatewayToken(SECRET, token, 2_000)).toMatchObject(claims);
    expect(verifyGatewayToken(SECRET, token, 1_000 + 5 * 60_000)).toBeNull();
    expect(/^[A-Za-z0-9_.-]+$/.test(token)).toBe(true);
  });

  it("reject other secrets, tampering and junk", () => {
    const { token } = signGatewayToken(SECRET, claims);
    expect(verifyGatewayToken("h".repeat(40), token)).toBeNull();
    const [body, mac] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), tenantId: "x" }),
    ).toString("base64url");
    expect(verifyGatewayToken(SECRET, `${forged}.${mac}`)).toBeNull();
    expect(verifyGatewayToken(SECRET, "nope")).toBeNull();
    expect(() => signGatewayToken("short", claims)).toThrow();
  });

  it("validates client messages", () => {
    expect(clientMessage.safeParse({ type: "hello", session: { id: "s1" } }).success).toBe(true);
    expect(clientMessage.safeParse({ type: "hello", session: {} }).success).toBe(false);
    expect(clientMessage.safeParse({ type: "exec", cmd: "rm" }).success).toBe(false);
  });
});
