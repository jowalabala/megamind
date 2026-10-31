"use server";

import { appendAuditEvent } from "@mm/audit";
import { closeChannel, CollabError, decide, setChannelsEnabled } from "@mm/collab";
import { collabSettings } from "@mm/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireMemberContext } from "../../lib/context";
import { db } from "../../lib/db";

// Only a signed-in person reaches these. Agents have no way in: the API refuses agent keys.

export async function decideChannel(formData: FormData): Promise<void> {
  const ctx = await requireMemberContext();
  const channelId = z.uuid().parse(formData.get("channelId"));
  const decision = z.enum(["approve", "decline"]).parse(formData.get("decision"));
  await db().withTenant(ctx.tenantId, (tx) =>
    decide(tx, ctx.tenantId, { channelId, memberId: ctx.member.id, decision, via: "web" }),
  );
  revalidatePath("/channels");
}

export async function closeChannelAction(formData: FormData): Promise<void> {
  const ctx = await requireMemberContext();
  const channelId = z.uuid().parse(formData.get("channelId"));
  await db().withTenant(ctx.tenantId, async (tx) => {
    try {
      // Participants close their own; admins can close any.
      await closeChannel(tx, ctx.tenantId, {
        channelId,
        by:
          ctx.member.role === "admin"
            ? { memberId: ctx.member.id, system: true }
            : { memberId: ctx.member.id },
        reason: ctx.member.role === "admin" ? "closed by an admin" : "closed by a participant",
      });
    } catch (err) {
      if (!(err instanceof CollabError)) throw err;
    }
  });
  revalidatePath("/channels");
}

export async function setCollabEnabled(formData: FormData): Promise<void> {
  const ctx = await requireMemberContext();
  if (ctx.member.role !== "admin") throw new Error("Only admins can change this.");
  const enabled = formData.get("enabled") === "true";
  await db().withTenant(ctx.tenantId, (tx) =>
    setChannelsEnabled(tx, ctx.tenantId, ctx.member.id, enabled),
  );
  revalidatePath("/channels");
}

export async function setCrossTeam(formData: FormData): Promise<void> {
  const ctx = await requireMemberContext();
  if (ctx.member.role !== "admin") throw new Error("Only admins can change this.");
  const allowed = formData.get("allowed") === "true";
  await db().withTenant(ctx.tenantId, async (tx) => {
    await tx
      .insert(collabSettings)
      .values({ tenantId: ctx.tenantId, crossTeamAllowed: allowed })
      .onConflictDoUpdate({
        target: collabSettings.tenantId,
        set: { crossTeamAllowed: allowed, updatedAt: new Date() },
      });
    await appendAuditEvent(tx, ctx.tenantId, {
      actorType: "member",
      actorId: ctx.member.id,
      action: "collab.cross_team_changed",
      targetType: "tenant",
      targetId: ctx.tenantId,
      payload: { allowed },
    });
  });
  revalidatePath("/channels");
}
