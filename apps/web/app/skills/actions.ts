"use server";

import { REVIEW_ACTIONS } from "@mm/db";
import { reviewSkill, setCategoryOwner } from "@mm/skills";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireMemberContext } from "../../lib/context";
import { db } from "../../lib/db";

export async function review(formData: FormData): Promise<void> {
  const ctx = await requireMemberContext();
  const skillId = z.uuid().parse(formData.get("skillId"));
  const action = z.enum(REVIEW_ACTIONS).parse(formData.get("action"));
  const version = formData.get("version")
    ? z.coerce.number().int().positive().parse(formData.get("version"))
    : undefined;
  const note = String(formData.get("note") ?? "").slice(0, 2000) || undefined;
  await db().withTenant(ctx.tenantId, (tx) =>
    reviewSkill(tx, ctx.tenantId, { skillId, memberId: ctx.member.id, action, version, note }),
  );
  revalidatePath(`/skills/${skillId}`);
  revalidatePath("/skills/review");
}

export async function assignOwner(formData: FormData): Promise<void> {
  const ctx = await requireMemberContext();
  const input = z
    .object({
      memberId: z.uuid(),
      pack: z.string().min(1).max(32),
      category: z.string().min(1).max(64),
      owner: z.enum(["true", "false"]),
    })
    .parse(Object.fromEntries(formData));
  await db().withTenant(ctx.tenantId, (tx) =>
    setCategoryOwner(tx, ctx.tenantId, {
      adminId: ctx.member.id,
      ...input,
      owner: input.owner === "true",
    }),
  );
  revalidatePath("/skills/review");
}
