// Short-lived gateway tokens. The API issues one to an authenticated agent; the gateway
// accepts it for 5 minutes, so agent keys never travel to the WebSocket endpoint and a
// leaked token is useless soon after. HMAC-SHA256 with a secret shared by API and gateway.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface GatewayClaims {
  tenantId: string;
  agentId: string;
  memberId: string;
  /** Unix ms. */
  exp: number;
  nonce: string;
}

export const TOKEN_TTL_MS = 5 * 60_000;
/** The subprotocol a client must offer, alongside "mm.token.<token>". */
export const PROTOCOL = "mm.v1";
export const TOKEN_PROTOCOL_PREFIX = "mm.token.";

function key(secret: string) {
  if (secret.length < 32) throw new Error("Gateway secret must be at least 32 characters");
  return createHmac("sha256", secret).update("mm:gateway-token").digest();
}

export function signGatewayToken(
  secret: string,
  claims: Omit<GatewayClaims, "exp" | "nonce">,
  now = Date.now(),
): { token: string; expiresAt: Date } {
  const full: GatewayClaims = {
    ...claims,
    exp: now + TOKEN_TTL_MS,
    nonce: randomBytes(9).toString("base64url"),
  };
  const body = Buffer.from(JSON.stringify(full)).toString("base64url");
  const mac = createHmac("sha256", key(secret)).update(body).digest("base64url");
  // Subprotocol values must be tokens per RFC 6455: base64url and "." are fine.
  return { token: `${body}.${mac}`, expiresAt: new Date(full.exp) };
}

export function verifyGatewayToken(
  secret: string,
  token: string,
  now = Date.now(),
): GatewayClaims | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", key(secret)).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as GatewayClaims;
    return claims.exp > now ? claims : null;
  } catch {
    return null;
  }
}
