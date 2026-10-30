// Typed mirror of the SQL migrations in ../migrations, which are the source of truth.
// test/schema-drift.test.ts fails if the two disagree.
import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
  boolean,
  doublePrecision,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  AGENT_KINDS,
  ARTIFACT_KINDS,
  CAPTURE_SOURCES,
  CATEGORY_SOURCES,
  DEFAULT_AGENT_SCOPES,
  type AgentScope,
} from "./constants.ts";

export const memberRole = pgEnum("member_role", ["admin", "category_owner", "member"]);
export const visibilityPref = pgEnum("visibility_pref", ["name", "team", "anonymous"]);

/** Generated full-text search column; written by Postgres, never by the app. */
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  workosOrgId: text("workos_org_id").unique(),
  region: text("region").notNull().default("us-east-1"),
  kmsKeyArn: text("kms_key_arn"),
  createdAt: createdAt(),
  lakeReadyAt: timestamp("lake_ready_at", { withTimezone: true }),
});

export const teams = pgTable("teams", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const members = pgTable("members", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  workosUserId: text("workos_user_id").notNull(),
  email: text("email").notNull(),
  displayName: text("display_name"),
  role: memberRole("role").notNull().default("member"),
  captureOptOut: boolean("capture_opt_out").notNull().default(false),
  creditOptIn: boolean("credit_opt_in").notNull().default(false),
  visibilityPref: visibilityPref("visibility_pref").notNull().default("team"),
  createdAt: createdAt(),
  githubUserId: bigint("github_user_id", { mode: "number" }),
});

export const teamMembers = pgTable(
  "team_members",
  {
    tenantId: uuid("tenant_id").notNull(),
    teamId: uuid("team_id").notNull(),
    memberId: uuid("member_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.memberId] })],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    tenantId: uuid("tenant_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    id: uuid("id").notNull().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    actorType: text("actor_type", { enum: ["member", "agent", "system"] }).notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.seq] })],
);

export const auditChainHeads = pgTable("audit_chain_heads", {
  tenantId: uuid("tenant_id").primaryKey(),
  lastSeq: bigint("last_seq", { mode: "number" }).notNull(),
  lastHash: text("last_hash").notNull(),
});

export const llmCalls = pgTable("llm_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  stage: text("stage").notNull(),
  promptId: text("prompt_id").notNull(),
  promptVersion: integer("prompt_version").notNull(),
  model: text("model").notNull(),
  status: text("status", {
    enum: ["ok", "error", "refusal", "truncated", "invalid_output"],
  }).notNull(),
  errorCode: text("error_code"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cacheReadTokens: integer("cache_read_tokens"),
  latencyMs: integer("latency_ms").notNull(),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
  inputHash: text("input_hash").notNull(),
  createdAt: createdAt(),
});

// Capture (migration 0005) -------------------------------------------------------

export const captureSource = pgEnum("capture_source", CAPTURE_SOURCES);
export const taskState = pgEnum("task_state", [
  "logged",
  "categorized",
  "awaiting_outcome",
  "judged",
  "excluded",
]);
export const actionKind = pgEnum("action_kind", [
  "tool_call",
  "edit",
  "command",
  "message",
  "outcome",
]);

export { AGENT_KINDS, AGENT_SCOPES, ARTIFACT_KINDS, type AgentScope } from "./constants.ts";

export const agentIdentities = pgTable("agent_identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  memberId: uuid("member_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind", { enum: AGENT_KINDS }).notNull(),
  keyPrefix: text("key_prefix").notNull(),
  scopes: text("scopes").array().$type<AgentScope[]>().notNull().default(DEFAULT_AGENT_SCOPES),
  createdByMemberId: uuid("created_by_member_id"),
  createdAt: createdAt(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

/** Write-only for the app role: hashes are inserted and deleted, never read back. */
export const agentKeys = pgTable("agent_keys", {
  keyHash: text("key_hash").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  agentIdentityId: uuid("agent_identity_id").notNull(),
  createdAt: createdAt(),
});

export const agentSessions = pgTable("agent_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  agentIdentityId: uuid("agent_identity_id").notNull(),
  memberId: uuid("member_id").notNull(),
  clientSessionId: text("client_session_id").notNull(),
  contextRedacted: jsonb("context_redacted").$type<Record<string, unknown>>().notNull().default({}),
  private: boolean("private").notNull().default(false),
  status: text("status", { enum: ["active", "ended"] })
    .notNull()
    .default("active"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  /** Null for connector tasks whose author hasn't linked an account; actorKey is set then. */
  memberId: uuid("member_id"),
  agentIdentityId: uuid("agent_identity_id"),
  agentSessionId: uuid("agent_session_id"),
  source: captureSource("source").notNull(),
  idempotencyKey: text("idempotency_key"),
  titleRedacted: text("title_redacted").notNull(),
  summaryRedacted: text("summary_redacted").notNull().default(""),
  categoryHint: text("category_hint"),
  features: jsonb("features").$type<Record<string, unknown>>().notNull().default({}),
  redactionCounts: jsonb("redaction_counts").$type<Record<string, number>>().notNull().default({}),
  state: taskState("state").notNull().default("logged"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  search: tsvector("search").generatedAlwaysAs(
    sql`to_tsvector('simple', mm_search_text(title_redacted || ' ' || summary_redacted))`,
  ),
  actorKey: text("actor_key"),
  connectionId: uuid("connection_id"),
  pack: text("pack"),
  category: text("category"),
  categorySource: text("category_source", { enum: CATEGORY_SOURCES }),
  categoryConfidence: real("category_confidence"),
});

export const artifacts = pgTable("artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  taskId: uuid("task_id").notNull(),
  kind: text("kind", { enum: ARTIFACT_KINDS }).notNull(),
  contentRedacted: text("content_redacted"),
  uriRedacted: text("uri_redacted"),
  createdAt: createdAt(),
});

export const externalRefs = pgTable(
  "external_refs",
  {
    tenantId: uuid("tenant_id").notNull(),
    taskId: uuid("task_id").notNull(),
    ref: text("ref").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.taskId, t.ref] })],
);

export const metricObservations = pgTable("metric_observations", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  taskId: uuid("task_id").notNull(),
  metricKey: text("metric_key").notNull(),
  value: doublePrecision("value").notNull(),
  n: integer("n").notNull().default(1),
  source: captureSource("source").notNull(),
  agentIdentityId: uuid("agent_identity_id"),
  noteRedacted: text("note_redacted"),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const actionEvents = pgTable(
  "action_events",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull(),
    sessionId: uuid("session_id").notNull(),
    memberId: uuid("member_id").notNull(),
    taskId: uuid("task_id"),
    kind: actionKind("kind").notNull(),
    summaryRedacted: text("summary_redacted").notNull(),
    resources: text("resources").array().notNull().default([]),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    source: captureSource("source").notNull().default("mcp"),
    search: tsvector("search").generatedAlwaysAs(
      sql`to_tsvector('simple', mm_search_text(summary_redacted))`,
    ),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

// Lake and erasure (migration 0006) ----------------------------------------------------

export const LAKE_TABLES = ["actions", "tasks", "metric_observations", "task_categories"] as const;
export type LakeTableName = (typeof LAKE_TABLES)[number];

export const lakeOutbox = pgTable("lake_outbox", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid("tenant_id").notNull(),
  memberId: uuid("member_id"),
  lakeTable: text("lake_table", { enum: LAKE_TABLES }).notNull(),
  eventId: uuid("event_id").notNull(),
  row: jsonb("row").$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
});

export const ERASURE_STATUSES = ["pending", "first_pass_done", "done", "failed"] as const;

export const erasureRequests = pgTable("erasure_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  subjectMemberId: uuid("subject_member_id").notNull(),
  requestedByMemberId: uuid("requested_by_member_id"),
  status: text("status", { enum: ERASURE_STATUSES }).notNull().default("pending"),
  bronzeDeletedAt: timestamp("bronze_deleted_at", { withTimezone: true }),
  lakeFirstPassAt: timestamp("lake_first_pass_at", { withTimezone: true }),
  lakeSecondPassDue: timestamp("lake_second_pass_due", { withTimezone: true }),
  lakeSecondPassAt: timestamp("lake_second_pass_at", { withTimezone: true }),
  physicallyErasedBy: timestamp("physically_erased_by", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  subjectActorKeys: text("subject_actor_keys").array().notNull().default([]),
});

// GitHub (migration 0007) ----------------------------------------------------------------

export const connections = pgTable("connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  provider: text("provider", { enum: ["github"] }).notNull(),
  externalId: text("external_id").notNull(),
  accountLogin: text("account_login"),
  status: text("status", { enum: ["active", "suspended", "removed"] })
    .notNull()
    .default("active"),
  createdByMemberId: uuid("created_by_member_id"),
  backfillStatus: text("backfill_status", { enum: ["pending", "running", "done", "failed"] })
    .notNull()
    .default("pending"),
  backfillState: jsonb("backfill_state")
    .$type<Record<string, { name: string; done: boolean; prs: number }>>()
    .notNull()
    .default({}),
  backfillError: text("backfill_error"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}
export interface PrReview {
  state: string;
  author_key: string;
  submitted_at: string | null;
}

export const githubPullRequests = pgTable(
  "github_pull_requests",
  {
    tenantId: uuid("tenant_id").notNull(),
    taskId: uuid("task_id").notNull(),
    connectionId: uuid("connection_id"),
    repoId: bigint("repo_id", { mode: "number" }).notNull(),
    repo: text("repo").notNull(),
    number: integer("number").notNull(),
    authorKey: text("author_key").notNull(),
    authorIsBot: boolean("author_is_bot").notNull().default(false),
    state: text("state", { enum: ["open", "closed", "merged"] }).notNull(),
    draft: boolean("draft").notNull().default(false),
    baseRef: text("base_ref").notNull(),
    headRefRedacted: text("head_ref_redacted").notNull(),
    headSha: text("head_sha"),
    mergeCommitSha: text("merge_commit_sha"),
    additions: integer("additions").notNull().default(0),
    deletions: integer("deletions").notNull().default(0),
    changedFiles: integer("changed_files").notNull().default(0),
    commits: integer("commits").notNull().default(0),
    labels: text("labels").array().notNull().default([]),
    files: jsonb("files").$type<PrFile[]>().notNull().default([]),
    reviews: jsonb("reviews").$type<PrReview[]>().notNull().default([]),
    closingIssues: integer("closing_issues").array().notNull().default([]),
    ciState: text("ci_state"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    ghUpdatedAt: timestamp("gh_updated_at", { withTimezone: true }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    lakeEmittedAt: timestamp("lake_emitted_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.taskId] })],
);

/** Every Drizzle table, used by the drift test. */
export const allTables = {
  tenants,
  teams,
  members,
  teamMembers,
  auditEvents,
  auditChainHeads,
  llmCalls,
  agentIdentities,
  agentKeys,
  agentSessions,
  tasks,
  artifacts,
  externalRefs,
  metricObservations,
  actionEvents,
  lakeOutbox,
  erasureRequests,
  connections,
  githubPullRequests,
};
