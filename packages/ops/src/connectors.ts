// Revokes a tenant's OAuth tokens at the providers, so nothing Master Mind held keeps working
// after the tenant is gone. Reads the sealed tokens as the owner role and opens them with the
// token vault (operator KMS rights in AWS).
import { readSealedConnectorSecrets } from "@mm/db/admin";
import { revokeRefreshToken } from "@mm/hubspot";
import { slackApi } from "@mm/slack";
import type { Vault } from "@mm/vault";

export interface RevokeOptions {
  adminUrl: string;
  vault: Vault;
  hubspotApiUrl?: string;
  slackApiUrl?: string;
  log?: (msg: string) => void;
}

export function connectorRevoker(options: RevokeOptions) {
  return async (tenantId: string): Promise<number> => {
    const rows = await readSealedConnectorSecrets(options.adminUrl, tenantId);
    let revoked = 0;
    for (const r of rows) {
      const purpose = `${r.provider}:${r.connectionId}:${r.kind}`;
      try {
        const token = await options.vault.open(tenantId, purpose, r.sealed);
        if (r.provider === "hubspot" && r.kind === "refresh_token") {
          await revokeRefreshToken({ apiUrl: options.hubspotApiUrl }, token);
          revoked++;
        } else if (r.provider === "slack" && r.kind === "bot_token") {
          await slackApi({ token, baseUrl: options.slackApiUrl }).call("auth.revoke", {});
          revoked++;
        }
      } catch (err) {
        // A token that no longer opens or is already revoked can't be used by anyone either.
        options.log?.(`could not revoke ${r.provider} token: ${(err as Error).message}`);
      }
    }
    return revoked;
  };
}
