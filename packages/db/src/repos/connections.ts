// Integrations (GitHub App installations) and members' linked accounts.
import { and, eq, isNull, sql } from "drizzle-orm";
import type { TenantTx } from "../client.ts";
import {
  connectionSecrets,
  connections,
  members,
  tasks,
  type ConnectionProvider,
} from "../schema.ts";

export type Connection = typeof connections.$inferSelect;

export class ConnectionConflictError extends Error {
  override name = "ConnectionConflictError";
}

/**
 * Records a verified GitHub App installation for this tenant. An installation can only ever
 * belong to one tenant: if another tenant has it, this throws.
 */
export async function upsertGithubInstallation(
  tx: TenantTx,
  tenantId: string,
  input: { installationId: string; accountLogin: string | null; createdByMemberId: string },
): Promise<{ connection: Connection; created: boolean }> {
  return upsertConnection(tx, tenantId, {
    provider: "github",
    externalId: input.installationId,
    accountLogin: input.accountLogin,
    createdByMemberId: input.createdByMemberId,
  });
}

/**
 * Records a verified connection (GitHub installation, HubSpot portal, Slack workspace). Each
 * external account belongs to one tenant, ever: if another tenant has it, this throws.
 * Slack has no history to import, so it starts with its backfill done.
 */
export async function upsertConnection(
  tx: TenantTx,
  tenantId: string,
  input: {
    provider: ConnectionProvider;
    externalId: string;
    accountLogin: string | null;
    createdByMemberId: string;
  },
): Promise<{ connection: Connection; created: boolean }> {
  const [existing] = await tx
    .select()
    .from(connections)
    .where(
      and(eq(connections.provider, input.provider), eq(connections.externalId, input.externalId)),
    );
  if (existing) {
    const [updated] = await tx
      .update(connections)
      .set({ status: "active", accountLogin: input.accountLogin, updatedAt: new Date() })
      .where(eq(connections.id, existing.id))
      .returning();
    return { connection: updated!, created: false };
  }
  try {
    // A savepoint, so a unique violation (another tenant owns it) doesn't poison the caller's transaction.
    const [row] = await tx.transaction((sp) =>
      sp
        .insert(connections)
        .values({
          tenantId,
          provider: input.provider,
          externalId: input.externalId,
          accountLogin: input.accountLogin,
          createdByMemberId: input.createdByMemberId,
          backfillStatus: input.provider === "slack" ? "done" : "pending",
        })
        .returning(),
    );
    return { connection: row!, created: true };
  } catch (err) {
    if ((err as { cause?: { code?: string }; code?: string }).cause?.code === "23505") {
      throw new ConnectionConflictError(
        `This ${PROVIDER_NAMES[input.provider]} account is connected to another workspace.`,
      );
    }
    throw err;
  }
}

const PROVIDER_NAMES: Record<ConnectionProvider, string> = {
  github: "GitHub",
  hubspot: "HubSpot",
  slack: "Slack",
};

export async function listConnections(
  tx: TenantTx,
  provider?: ConnectionProvider,
): Promise<Connection[]> {
  const q = tx.select().from(connections);
  return (provider ? q.where(eq(connections.provider, provider)) : q).orderBy(
    connections.createdAt,
  );
}

/** The tenant's active connection to a provider, if any (the newest one). */
export async function activeConnection(
  tx: TenantTx,
  provider: ConnectionProvider,
): Promise<Connection | null> {
  const [row] = await tx
    .select()
    .from(connections)
    .where(and(eq(connections.provider, provider), eq(connections.status, "active")))
    .orderBy(sql`${connections.createdAt} DESC`)
    .limit(1);
  return row ?? null;
}

/** Stores an OAuth token already sealed by the token vault. */
export async function saveSecret(
  tx: TenantTx,
  tenantId: string,
  connectionId: string,
  kind: "refresh_token" | "bot_token",
  sealed: string,
): Promise<void> {
  await tx
    .insert(connectionSecrets)
    .values({ tenantId, connectionId, kind, sealed })
    .onConflictDoUpdate({
      target: [connectionSecrets.tenantId, connectionSecrets.connectionId, connectionSecrets.kind],
      set: { sealed, updatedAt: new Date() },
    });
}

export async function loadSecret(
  tx: TenantTx,
  connectionId: string,
  kind: "refresh_token" | "bot_token",
): Promise<string | null> {
  const [row] = await tx
    .select({ sealed: connectionSecrets.sealed })
    .from(connectionSecrets)
    .where(and(eq(connectionSecrets.connectionId, connectionId), eq(connectionSecrets.kind, kind)));
  return row?.sealed ?? null;
}

export async function getConnection(tx: TenantTx, id: string): Promise<Connection | null> {
  const [row] = await tx.select().from(connections).where(eq(connections.id, id));
  return row ?? null;
}

export async function setConnectionStatus(
  tx: TenantTx,
  id: string,
  status: Connection["status"],
): Promise<void> {
  await tx.update(connections).set({ status, updatedAt: new Date() }).where(eq(connections.id, id));
}

/** Active connections to a provider waiting for their first (or a requested) backfill. */
export async function pendingBackfills(
  tx: TenantTx,
  provider: ConnectionProvider = "github",
): Promise<Connection[]> {
  return tx
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.provider, provider),
        eq(connections.status, "active"),
        eq(connections.backfillStatus, "pending"),
      ),
    );
}

export async function updateBackfill(
  tx: TenantTx,
  id: string,
  patch: Partial<Pick<Connection, "backfillStatus" | "backfillError">> & {
    /** Merged into one repository's entry in backfill_state. */
    repo?: { id: string; name?: string; done?: boolean; addPrs?: number };
  },
): Promise<Connection> {
  const { repo, ...fields } = patch;
  const stateExpr = repo
    ? sql`jsonb_set(
        ${connections.backfillState},
        ${`{${repo.id}}`}::text[],
        coalesce(${connections.backfillState} -> ${repo.id}, '{"done": false, "prs": 0}'::jsonb)
          || jsonb_strip_nulls(jsonb_build_object(
               'name', ${repo.name ?? null}::text,
               'done', ${repo.done ?? null}::boolean,
               'prs', coalesce((${connections.backfillState} -> ${repo.id} ->> 'prs')::int, 0) + ${repo.addPrs ?? 0}
             )),
        true)`
    : undefined;
  const [row] = await tx
    .update(connections)
    .set({ ...fields, ...(stateExpr ? { backfillState: stateExpr } : {}), updatedAt: new Date() })
    .where(eq(connections.id, id))
    .returning();
  return row!;
}

export class AccountAlreadyLinkedError extends Error {
  override name = "AccountAlreadyLinkedError";
}

/**
 * Links a member to their GitHub user id (verified by an OAuth round trip), and claims the
 * tasks already captured under that identity.
 */
export async function linkGithubAccount(
  tx: TenantTx,
  memberId: string,
  githubUserId: number,
): Promise<{ claimedTasks: number }> {
  const [other] = await tx
    .select({ id: members.id })
    .from(members)
    .where(eq(members.githubUserId, githubUserId));
  if (other && other.id !== memberId) {
    throw new AccountAlreadyLinkedError("That GitHub account is linked to another member.");
  }
  await tx.update(members).set({ githubUserId }).where(eq(members.id, memberId));
  const claimed = await tx
    .update(tasks)
    .set({ memberId, updatedAt: new Date() })
    .where(and(eq(tasks.actorKey, `github:${githubUserId}`), isNull(tasks.memberId)))
    .returning({ id: tasks.id });
  return { claimedTasks: claimed.length };
}
