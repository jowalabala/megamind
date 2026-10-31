// The token vault: seals OAuth tokens (HubSpot refresh tokens, Slack bot tokens) before they
// reach the database, and opens them only in the process that calls the provider.
//
// Every sealed value is bound to its tenant and purpose (e.g. "hubspot:<connection id>"):
// a value copied to another tenant or connection won't open. In AWS that binding is the KMS
// encryption context, which CloudTrail logs with every decrypt. Locally it is the AES-GCM
// associated data, with a key derived from a development secret.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";

export interface Vault {
  seal(tenantId: string, purpose: string, plaintext: string): Promise<string>;
  open(tenantId: string, purpose: string, sealed: string): Promise<string>;
}

export class VaultError extends Error {
  override name = "VaultError";
}

const binding = (tenantId: string, purpose: string) => `mm:${tenantId}:${purpose}`;

/** AES-256-GCM with a per-tenant key derived from `secret`. For development and tests. */
export function localVault(secret: string): Vault {
  if (secret.length < 32) throw new VaultError("The vault secret must be at least 32 characters.");
  const keyFor = (tenantId: string) =>
    Buffer.from(hkdfSync("sha256", secret, "mm-vault", `tenant:${tenantId}`, 32));
  return {
    async seal(tenantId, purpose, plaintext) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", keyFor(tenantId), iv);
      c.setAAD(Buffer.from(binding(tenantId, purpose)));
      const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
      return `l1.${Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url")}`;
    },
    async open(tenantId, purpose, sealed) {
      const [tag, data] = sealed.split(".");
      if (tag !== "l1" || !data) throw new VaultError("Not a value sealed by the local vault.");
      const raw = Buffer.from(data, "base64url");
      try {
        const d = createDecipheriv("aes-256-gcm", keyFor(tenantId), raw.subarray(0, 12));
        d.setAAD(Buffer.from(binding(tenantId, purpose)));
        d.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
      } catch {
        throw new VaultError("The sealed value doesn't open for this tenant and purpose.");
      }
    },
  };
}

/** KMS-backed: each value is encrypted under `keyId` with the tenant and purpose as context. */
export function kmsVault(options: { keyId: string; region?: string; client?: KMSClient }): Vault {
  const kms = options.client ?? new KMSClient({ region: options.region });
  const context = (tenantId: string, purpose: string) => ({
    tenant_id: tenantId,
    purpose: purpose.slice(0, 200),
  });
  return {
    async seal(tenantId, purpose, plaintext) {
      const res = await kms.send(
        new EncryptCommand({
          KeyId: options.keyId,
          Plaintext: Buffer.from(plaintext, "utf8"),
          EncryptionContext: context(tenantId, purpose),
        }),
      );
      if (!res.CiphertextBlob) throw new VaultError("KMS returned no ciphertext.");
      return `k1.${Buffer.from(res.CiphertextBlob).toString("base64url")}`;
    },
    async open(tenantId, purpose, sealed) {
      const [tag, data] = sealed.split(".");
      if (tag !== "k1" || !data) throw new VaultError("Not a value sealed by KMS.");
      const res = await kms.send(
        new DecryptCommand({
          KeyId: options.keyId,
          CiphertextBlob: Buffer.from(data, "base64url"),
          EncryptionContext: context(tenantId, purpose),
        }),
      );
      if (!res.Plaintext) throw new VaultError("KMS returned no plaintext.");
      return Buffer.from(res.Plaintext).toString("utf8");
    },
  };
}

/** KMS when MM_VAULT_KMS_KEY_ID is set (required in production), else the local vault. */
export function vaultFromEnv(env: NodeJS.ProcessEnv = process.env): Vault | null {
  if (env.MM_VAULT_KMS_KEY_ID) {
    return kmsVault({ keyId: env.MM_VAULT_KMS_KEY_ID, region: env.AWS_REGION });
  }
  if (env.NODE_ENV === "production") {
    throw new VaultError("MM_VAULT_KMS_KEY_ID is required in production.");
  }
  // In development, derive from the pseudonym secret so there's one less thing to set up.
  const secret = env.MM_VAULT_SECRET ?? env.MM_PSEUDONYM_SECRET;
  if (!secret || secret.length < 32) return null;
  return localVault(createHash("sha256").update(`vault:${secret}`).digest("hex"));
}
