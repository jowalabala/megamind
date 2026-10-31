import { describe, expect, it } from "vitest";
import { localVault, vaultFromEnv, VaultError } from "../src/index.ts";

const vault = localVault("a-development-secret-of-at-least-32-chars");
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

describe("local vault", () => {
  it("round-trips, and never stores the token as-is", async () => {
    const sealed = await vault.seal(T1, "hubspot:c1", "refresh-token-value");
    expect(sealed).not.toContain("refresh-token-value");
    expect(await vault.open(T1, "hubspot:c1", sealed)).toBe("refresh-token-value");
    // Fresh IV each time.
    expect(await vault.seal(T1, "hubspot:c1", "refresh-token-value")).not.toBe(sealed);
  });

  it("is bound to its tenant and purpose", async () => {
    const sealed = await vault.seal(T1, "hubspot:c1", "x");
    await expect(vault.open(T2, "hubspot:c1", sealed)).rejects.toBeInstanceOf(VaultError);
    await expect(vault.open(T1, "hubspot:c2", sealed)).rejects.toBeInstanceOf(VaultError);
    await expect(vault.open(T1, "hubspot:c1", `${sealed}x`)).rejects.toBeInstanceOf(VaultError);
  });

  it("needs KMS in production", () => {
    expect(() => vaultFromEnv({ NODE_ENV: "production" })).toThrow(/MM_VAULT_KMS_KEY_ID/);
    expect(vaultFromEnv({ MM_PSEUDONYM_SECRET: "short" })).toBeNull();
    expect(vaultFromEnv({ MM_PSEUDONYM_SECRET: "x".repeat(40) })).not.toBeNull();
  });
});
