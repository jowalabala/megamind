import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { TenantTx } from "../client.ts";
import { DEFAULT_AGENT_SCOPES } from "../constants.ts";
import { AGENT_KINDS, agentIdentities, agentKeys, type AgentScope } from "../schema.ts";

export type AgentIdentity = typeof agentIdentities.$inferSelect;
export type AgentKind = (typeof AGENT_KINDS)[number];

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const AGENT_KEY_RE = /^mm_(live|test)_[A-Za-z0-9]{40}$/;

/** sha256 is enough here: keys are 238 bits of randomness, so they can't be guessed or brute-forced. */
export function hashAgentKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateAgentKey(env: "live" | "test" = "live") {
  // Rejection sampling keeps every character uniformly random.
  let body = "";
  while (body.length < 40) {
    for (const b of randomBytes(64)) {
      if (b < 248 && body.length < 40) body += BASE62[b % 62];
    }
  }
  const key = `mm_${env}_${body}`;
  return { key, prefix: key.slice(0, `mm_${env}_`.length + 8), hash: hashAgentKey(key) };
}

export interface CreateAgentInput {
  memberId: string;
  name: string;
  kind: AgentKind;
  scopes?: AgentScope[];
  createdByMemberId: string;
  env?: "live" | "test";
}

/** Creates an agent and its key. The plaintext key is returned once and never stored. */
export async function createAgent(
  tx: TenantTx,
  tenantId: string,
  input: CreateAgentInput,
): Promise<{ agent: AgentIdentity; key: string }> {
  const { key, prefix, hash } = generateAgentKey(input.env);
  const [agent] = await tx
    .insert(agentIdentities)
    .values({
      tenantId,
      memberId: input.memberId,
      name: input.name,
      kind: input.kind,
      keyPrefix: prefix,
      scopes: input.scopes ?? DEFAULT_AGENT_SCOPES,
      createdByMemberId: input.createdByMemberId,
    })
    .returning();
  await tx.insert(agentKeys).values({ keyHash: hash, tenantId, agentIdentityId: agent!.id });
  return { agent: agent!, key };
}

/** Revokes an agent: its key stops working at once and the hash is deleted. */
export async function revokeAgent(tx: TenantTx, agentId: string): Promise<AgentIdentity | null> {
  const [agent] = await tx
    .update(agentIdentities)
    .set({ revokedAt: new Date() })
    .where(and(eq(agentIdentities.id, agentId), isNull(agentIdentities.revokedAt)))
    .returning();
  await tx.delete(agentKeys).where(eq(agentKeys.agentIdentityId, agentId));
  return agent ?? null;
}

export async function listAgents(tx: TenantTx, filter: { memberId?: string } = {}) {
  return tx
    .select()
    .from(agentIdentities)
    .where(filter.memberId ? eq(agentIdentities.memberId, filter.memberId) : undefined)
    .orderBy(asc(agentIdentities.createdAt));
}

export async function getAgent(tx: TenantTx, agentId: string): Promise<AgentIdentity | null> {
  const rows = await tx.select().from(agentIdentities).where(eq(agentIdentities.id, agentId));
  return rows[0] ?? null;
}
