import { migrate } from "../migrate.ts";

const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error("DATABASE_ADMIN_URL is required (owner/migration role, not mm_app).");
  process.exit(1);
}
const result = await migrate(url);
console.log(
  `Applied: ${result.applied.join(", ") || "none"}. Already applied: ${result.skipped.length}.`,
);
