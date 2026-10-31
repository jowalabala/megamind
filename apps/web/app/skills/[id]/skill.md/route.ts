import { getServedSkill, skillMarkdown, skillSlug } from "@mm/skills";
import { requireMemberContext } from "../../../../lib/context";
import { db } from "../../../../lib/db";

/** The served version as a Claude Code SKILL.md file. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireMemberContext();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const found = await db().withTenant(ctx.tenantId, (tx) => getServedSkill(tx, id));
  if (found.status !== "served") {
    return new Response("This skill isn't served (not approved yet, or retired).", { status: 404 });
  }
  return new Response(skillMarkdown(found.skill), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${skillSlug(found.skill)}-SKILL.md"`,
      "cache-control": "no-store",
    },
  });
}
