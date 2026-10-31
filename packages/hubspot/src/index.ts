export {
  authorizeUrl,
  exchangeCode,
  HUBSPOT_SCOPES,
  hubspotClient,
  HubspotError,
  HubspotRateLimitedError,
  listOwners,
  listSequences,
  OUTCOME_PROPERTIES,
  refreshTokens,
  SEQUENCES_PATH,
  sequenceCounts,
  tokenInfo,
  type HubspotClient,
  type HubspotConfig,
  type Owner,
  type Sequence,
  type Tokens,
} from "./client.ts";
export {
  finalizeSequenceOutcomes,
  refreshTokenPurpose,
  SEQUENCE_METRICS,
  SEQUENCE_OUTCOMES,
  sequenceTaskId,
  storeRefreshToken,
  syncHubspot,
  upsertSequence,
  type HubspotDeps,
  type SequenceSyncResult,
} from "./sync.ts";

/** HubSpot app settings from the environment, or null when HubSpot isn't configured. */
export function hubspotConfigFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const clientId = env.MM_HUBSPOT_CLIENT_ID;
  const clientSecret = env.MM_HUBSPOT_CLIENT_SECRET;
  const redirectUri = env.MM_HUBSPOT_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return {
    clientId,
    clientSecret,
    redirectUri,
    apiUrl: env.MM_HUBSPOT_API_URL || undefined,
    appUrl: env.MM_HUBSPOT_APP_URL || undefined,
  };
}
