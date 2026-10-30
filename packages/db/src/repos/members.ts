import { and, asc, eq } from "drizzle-orm";
import type { TenantTx } from "../client.ts";
import { members, teamMembers, teams } from "../schema.ts";

export type Member = typeof members.$inferSelect;

export async function findMemberByWorkosUser(
  tx: TenantTx,
  workosUserId: string,
): Promise<Member | null> {
  const rows = await tx
    .select()
    .from(members)
    .where(eq(members.workosUserId, workosUserId))
    .limit(1);
  return rows[0] ?? null;
}

/** Adds a member on first login. Returns the member and whether it was just created. */
export async function ensureMember(
  tx: TenantTx,
  tenantId: string,
  input: { workosUserId: string; email: string; displayName: string | null },
): Promise<{ member: Member; created: boolean }> {
  const inserted = await tx
    .insert(members)
    .values({ tenantId, ...input })
    .onConflictDoNothing({ target: [members.tenantId, members.workosUserId] })
    .returning();
  if (inserted[0]) return { member: inserted[0], created: true };
  const existing = await findMemberByWorkosUser(tx, input.workosUserId);
  if (!existing) throw new Error("Member insert conflicted but no row is visible");
  return { member: existing, created: false };
}

export async function listMembers(tx: TenantTx): Promise<Member[]> {
  return tx.select().from(members).orderBy(asc(members.createdAt));
}

export async function listTeamsWithMemberCounts(tx: TenantTx) {
  const allTeams = await tx.select().from(teams).orderBy(asc(teams.name));
  const links = await tx.select().from(teamMembers);
  return allTeams.map((t) => ({
    ...t,
    memberCount: links.filter((l) => l.teamId === t.id).length,
  }));
}

export async function addMemberToTeam(
  tx: TenantTx,
  tenantId: string,
  teamId: string,
  memberId: string,
) {
  await tx.insert(teamMembers).values({ tenantId, teamId, memberId }).onConflictDoNothing();
}

export async function memberIsAdmin(tx: TenantTx, memberId: string): Promise<boolean> {
  const rows = await tx
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.id, memberId), eq(members.role, "admin")))
    .limit(1);
  return rows.length > 0;
}
