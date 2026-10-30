// Local development only: enables mm_app login and seeds two tenants.
import pg from "pg";
import { createDb } from "../client.ts";
import { migrate } from "../migrate.ts";
import { addMemberToTeam, ensureMember } from "../repos/members.ts";
import { teams } from "../schema.ts";

const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.error("DATABASE_ADMIN_URL and DATABASE_URL are required.");
  process.exit(1);
}
const appPassword = decodeURIComponent(new URL(appUrl).password);
if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(adminUrl).hostname)) {
  console.error("Refusing to seed a non-local database.");
  process.exit(1);
}

await migrate(adminUrl);
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`ALTER ROLE mm_app LOGIN PASSWORD ${pg.escapeLiteral(appPassword)}`);
const { rows } = await admin.query<{ slug: string }>("SELECT slug FROM tenants");
await admin.end();

const db = createDb({ connectionString: appUrl });
const existing = new Set(rows.map((r) => r.slug));
for (const [name, slug] of [
  ["Acme Corp", "acme"],
  ["Globex", "globex"],
] as const) {
  if (existing.has(slug)) continue;
  const t = await db.system.provisionTenant({
    name,
    slug,
    workosOrgId: null,
    admin: {
      workosUserId: `seed_${slug}_admin`,
      email: `admin@${slug}.test`,
      displayName: "Seed Admin",
    },
  });
  await db.withTenant(t.tenantId, async (tx) => {
    const [team] = await tx
      .insert(teams)
      .values({ tenantId: t.tenantId, name: "Platform" })
      .returning();
    const { member } = await ensureMember(tx, t.tenantId, {
      workosUserId: `seed_${slug}_dev`,
      email: `dev@${slug}.test`,
      displayName: "Seed Developer",
    });
    await addMemberToTeam(tx, t.tenantId, team!.id, member.id);
  });
  console.log(`Seeded tenant ${slug} (${t.tenantId})`);
}
await db.close();
