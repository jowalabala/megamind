// Local development only: creates an agent key for a seeded member and prints it, so the
// API can be tried before WorkOS sign-in is set up. Run `pnpm db:seed` first.
// Usage: pnpm --filter @mm/db dev:agent-key [tenant-slug] [member-email]
import { eq } from "drizzle-orm";
import pg from "pg";
import { createDb } from "../client.ts";
import { createAgent } from "../repos/agents.ts";
import { members } from "../schema.ts";

const appUrl = process.env.DATABASE_URL;
const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!appUrl || !adminUrl) {
  console.error("DATABASE_URL and DATABASE_ADMIN_URL are required.");
  process.exit(1);
}
if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(appUrl).hostname)) {
  console.error("Refusing to create dev keys on a non-local database.");
  process.exit(1);
}
const slug = process.argv[2] ?? "acme";
const email = process.argv[3] ?? `dev@${slug}.test`;

// Tenant lookup by slug is a control-plane read, so it uses the admin connection.
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
const { rows } = await admin.query<{ id: string }>("SELECT id FROM tenants WHERE slug = $1", [
  slug,
]);
await admin.end();
const tenantId = rows[0]?.id;
if (!tenantId) {
  console.error(`No tenant "${slug}". Run pnpm db:seed first.`);
  process.exit(1);
}

const db = createDb({ connectionString: appUrl });
const { key, agent } = await db.withTenant(tenantId, async (tx) => {
  const [member] = await tx
    .select({ id: members.id })
    .from(members)
    .where(eq(members.email, email));
  const memberId = member?.id;
  if (!memberId) throw new Error(`No member ${email} in ${slug}.`);
  return createAgent(tx, tenantId, {
    memberId,
    name: "Dev agent",
    kind: "custom",
    createdByMemberId: memberId,
    env: "test",
  });
});
await db.close();
console.log(`Agent ${agent.id} for ${email} in ${slug}. Key (shown once):\n${key}`);
