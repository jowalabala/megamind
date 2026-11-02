// The owner (migration role) database URL: DATABASE_ADMIN_URL, or built from the RDS master
// secret in AWS (MM_DB_OWNER_SECRET_ARN + MM_DB_HOST).
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export async function ownerDatabaseUrl(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.DATABASE_ADMIN_URL) return env.DATABASE_ADMIN_URL;
  const arn = env.MM_DB_OWNER_SECRET_ARN;
  if (!arn) throw new Error("Set DATABASE_ADMIN_URL, or MM_DB_OWNER_SECRET_ARN in AWS.");
  const sm = new SecretsManagerClient({ region: env.AWS_REGION });
  const out = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const s = JSON.parse(out.SecretString ?? "{}") as {
    username?: string;
    password?: string;
    host?: string;
    port?: number;
    dbname?: string;
  };
  const host = env.MM_DB_HOST ?? s.host;
  if (!s.username || !s.password || !host) throw new Error("The owner secret is incomplete.");
  const u = new URL(`postgres://${host}:${s.port ?? 5432}/${s.dbname ?? "mastermind"}`);
  u.username = s.username;
  u.password = s.password;
  u.searchParams.set("sslmode", "require");
  return u.toString();
}
