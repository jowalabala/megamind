"use server";

import { appendAuditEvent } from "@mm/audit";
import { AGENT_KINDS, agentRepo } from "@mm/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireMemberContext } from "../../../lib/context";
import { db } from "../../../lib/db";

const CreateAgent = z.object({
  name: z.string().trim().min(1, "Give the agent a name.").max(100),
  kind: z.enum(AGENT_KINDS),
});

export type CreateAgentState =
  { error: string } | { ok: true; name: string; key: string } | undefined;

/** Creates an agent for the signed-in member. The key is shown once and never stored. */
export async function createAgent(
  _prev: CreateAgentState,
  formData: FormData,
): Promise<CreateAgentState> {
  const ctx = await requireMemberContext();
  const parsed = CreateAgent.safeParse({ name: formData.get("name"), kind: formData.get("kind") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const { key } = await db().withTenant(ctx.tenantId, async (tx) => {
    const created = await agentRepo.createAgent(tx, ctx.tenantId, {
      memberId: ctx.member.id,
      name: parsed.data.name,
      kind: parsed.data.kind,
      scopes: ["capture:write"],
      createdByMemberId: ctx.member.id,
    });
    await appendAuditEvent(tx, ctx.tenantId, {
      actorType: "member",
      actorId: ctx.member.id,
      action: "agent.created",
      targetType: "agent",
      targetId: created.agent.id,
      payload: {
        kind: created.agent.kind,
        scopes: created.agent.scopes,
        keyPrefix: created.agent.keyPrefix,
      },
    });
    return created;
  });
  revalidatePath("/settings/agents");
  return { ok: true, name: parsed.data.name, key };
}

/** Members can revoke their own agents; admins can revoke any agent in the tenant. */
export async function revokeAgent(formData: FormData): Promise<void> {
  const ctx = await requireMemberContext();
  const agentId = z.uuid().parse(formData.get("agentId"));
  await db().withTenant(ctx.tenantId, async (tx) => {
    const agent = await agentRepo.getAgent(tx, agentId);
    if (!agent) return;
    if (agent.memberId !== ctx.member.id && ctx.member.role !== "admin") {
      throw new Error("You can only revoke your own agents.");
    }
    const revoked = await agentRepo.revokeAgent(tx, agentId);
    if (!revoked) return;
    await appendAuditEvent(tx, ctx.tenantId, {
      actorType: "member",
      actorId: ctx.member.id,
      action: "agent.revoked",
      targetType: "agent",
      targetId: agentId,
      payload: { ownerMemberId: agent.memberId },
    });
  });
  revalidatePath("/settings/agents");
}
