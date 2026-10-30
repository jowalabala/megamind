const REQUIRED = [
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "WORKOS_COOKIE_PASSWORD",
  "NEXT_PUBLIC_WORKOS_REDIRECT_URI",
] as const;

export function missingConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = REQUIRED.filter((k) => !env[k]);
  if (!env.DATABASE_URL && !env.DATABASE_HOST) missing.push("DATABASE_URL");
  return missing;
}

export function authConfigured(): boolean {
  return missingConfig().length === 0;
}
