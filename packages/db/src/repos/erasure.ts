// Member erasure. Postgres data goes at once (the member row cascades to everything they
// captured); raw payloads and lake rows are removed by the worker afterwards.
import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { TenantTx } from "../client.ts";
import { erasureRequests, members, tasks } from "../schema.ts";

export type ErasureRequest = typeof erasureRequests.$inferSelect;

export class ErasureNotAllowedError extends Error {
  override name = "ErasureNotAllowedError";
}

/**
 * Records the request and deletes the member with everything they captured, in the
 * caller's transaction (so the caller can add its audit event atomically).
 */
export async function requestMemberErasure(
  tx: TenantTx,
  tenantId: string,
  input: { subjectMemberId: string; requestedByMemberId: string },
): Promise<ErasureRequest> {
  if (input.subjectMemberId === input.requestedByMemberId) {
    throw new ErasureNotAllowedError("Admins can't erase themselves; ask another admin.");
  }
  const [subject] = await tx
    .select({ id: members.id, githubUserId: members.githubUserId })
    .from(members)
    .where(eq(members.id, input.subjectMemberId))
    .for("update");
  if (!subject) throw new ErasureNotAllowedError("That member doesn't exist.");
  // Connector data may be keyed only by their external identity.
  const actorKeys = subject.githubUserId ? [`github:${subject.githubUserId}`] : [];

  const [request] = await tx
    .insert(erasureRequests)
    .values({
      tenantId,
      subjectMemberId: input.subjectMemberId,
      requestedByMemberId: input.requestedByMemberId,
      subjectActorKeys: actorKeys,
    })
    .returning();
  if (actorKeys.length) await tx.delete(tasks).where(inArray(tasks.actorKey, actorKeys));
  await tx.delete(members).where(eq(members.id, input.subjectMemberId));
  return request!;
}

/** Requests with work to do now: new ones, and second lake passes that are due. */
export async function dueErasureRequests(tx: TenantTx, now = new Date()) {
  return tx
    .select()
    .from(erasureRequests)
    .where(
      or(
        eq(erasureRequests.status, "pending"),
        and(
          eq(erasureRequests.status, "first_pass_done"),
          lte(erasureRequests.lakeSecondPassDue, now),
        ),
      ),
    )
    .orderBy(erasureRequests.createdAt)
    .limit(20);
}

export async function updateErasureRequest(
  tx: TenantTx,
  id: string,
  patch: Partial<
    Pick<
      ErasureRequest,
      | "status"
      | "bronzeDeletedAt"
      | "lakeFirstPassAt"
      | "lakeSecondPassDue"
      | "lakeSecondPassAt"
      | "physicallyErasedBy"
      | "lastError"
    >
  > & { incrementAttempts?: boolean },
) {
  const { incrementAttempts, ...fields } = patch;
  await tx
    .update(erasureRequests)
    .set({
      ...fields,
      updatedAt: new Date(),
      ...(incrementAttempts ? { attempts: sql`${erasureRequests.attempts} + 1` } : {}),
    })
    .where(eq(erasureRequests.id, id));
}

export async function listErasureRequests(tx: TenantTx, ids?: string[]) {
  const q = tx.select().from(erasureRequests);
  return ids ? q.where(inArray(erasureRequests.id, ids)) : q.orderBy(erasureRequests.createdAt);
}
