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
  SKILL_ADHERENCE,
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
  /** Set while deletion is scheduled: agent keys, webhooks and jobs stop for this tenant. */
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
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
  slackUserId: text("slack_user_id"),
  hubspotUserId: bigint("hubspot_user_id", { mode: "number" }),
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

export const LAKE_TABLES = [
  "actions",
  "tasks",
  "metric_observations",
  "task_categories",
  "judgments",
  "channel_messages",
  "skill_usage",
] as const;
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

export const CONNECTION_PROVIDERS = ["github", "hubspot", "slack"] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];

export const connections = pgTable("connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  provider: text("provider", { enum: CONNECTION_PROVIDERS }).notNull(),
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
    baseSha: text("base_sha"),
    firstCiState: text("first_ci_state"),
    revertsPrs: integer("reverts_prs").array().notNull().default([]),
    revertsShas: text("reverts_shas").array().notNull().default([]),
    conflictCommits: integer("conflict_commits").notNull().default(0),
    baseMergeCommits: integer("base_merge_commits").notNull().default(0),
    szzDoneAt: timestamp("szz_done_at", { withTimezone: true }),
    metricsFinalAt: timestamp("metrics_final_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.taskId] })],
);

// Outcomes and judgments (migration 0008) --------------------------------------------------

export const githubPrLinks = pgTable(
  "github_pr_links",
  {
    tenantId: uuid("tenant_id").notNull(),
    fromTaskId: uuid("from_task_id").notNull(),
    toTaskId: uuid("to_task_id").notNull(),
    kind: text("kind", { enum: ["reverts", "fixes"] }).notNull(),
    evidence: jsonb("evidence").$type<Record<string, number>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.fromTaskId, t.toTaskId, t.kind] })],
);

export const VERDICTS = ["success", "failure", "neutral", "inconclusive"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface JudgmentReason {
  rule: string;
  metric: string;
  value: number | null;
  threshold: number | null;
  result: "true" | "false" | "unknown";
}

export const judgments = pgTable("judgments", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  taskId: uuid("task_id").notNull(),
  pack: text("pack").notNull(),
  rulesetVersion: integer("ruleset_version").notNull(),
  category: text("category"),
  verdict: text("verdict", { enum: VERDICTS }).notNull(),
  reasons: jsonb("reasons").$type<JudgmentReason[]>().notNull().default([]),
  baseline: jsonb("baseline").$type<Record<string, Record<string, number>>>().notNull().default({}),
  inputHash: text("input_hash").notNull(),
  judgedAt: timestamp("judged_at", { withTimezone: true }).notNull().defaultNow(),
});

// Skill drafts (migration 0009) -------------------------------------------------------------

export interface SkillDraftBody {
  when_to_use: string;
  preconditions: string[];
  steps: { text: string; evidence: string[] }[];
  anti_patterns: { text: string; evidence: string[] }[];
  expected_outcome: string;
}

export const skillDrafts = pgTable("skill_drafts", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  pack: text("pack").notNull(),
  category: text("category").notNull(),
  windowFrom: timestamp("window_from", { withTimezone: true }),
  windowTo: timestamp("window_to", { withTimezone: true }).notNull(),
  status: text("status", { enum: ["draft", "rejected", "accepted"] })
    .notNull()
    .default("draft"),
  title: text("title").notNull(),
  body: jsonb("body").$type<SkillDraftBody>().notNull(),
  cohort: jsonb("cohort")
    .$type<{ success: string[]; failure: string[]; hints: unknown[] }>()
    .notNull(),
  droppedCitations: integer("dropped_citations").notNull().default(0),
  lowConfidence: boolean("low_confidence").notNull().default(false),
  promptId: text("prompt_id").notNull(),
  promptVersion: integer("prompt_version").notNull(),
  createdAt: createdAt(),
  gate: jsonb("gate").$type<Record<string, unknown>>(),
  skillId: uuid("skill_id"),
});

// Awareness and skills (migration 0010) -----------------------------------------------------

export const intents = pgTable("intents", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  sessionId: uuid("session_id").notNull(),
  memberId: uuid("member_id").notNull(),
  descriptionRedacted: text("description_redacted").notNull(),
  resources: text("resources").array().notNull().default([]),
  status: text("status", { enum: ["active", "done", "abandoned"] })
    .notNull()
    .default("active"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const OVERLAP_KINDS = ["same_lines", "same_resource", "related_work"] as const;
export type OverlapKind = (typeof OVERLAP_KINDS)[number];

export const sessionOverlaps = pgTable("session_overlaps", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  sessionA: uuid("session_a").notNull(),
  sessionB: uuid("session_b").notNull(),
  kind: text("kind", { enum: OVERLAP_KINDS }).notNull(),
  severity: text("severity", { enum: ["high", "medium", "low"] }).notNull(),
  resource: text("resource").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  notifiedAAt: timestamp("notified_a_at", { withTimezone: true }),
  notifiedBAt: timestamp("notified_b_at", { withTimezone: true }),
});

export const skills = pgTable("skills", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  pack: text("pack").notNull(),
  category: text("category").notNull(),
  practiceKey: text("practice_key").notNull(),
  title: text("title").notNull(),
  status: text("status", { enum: ["in_review", "approved", "retired"] })
    .notNull()
    .default("in_review"),
  currentVersion: integer("current_version").notNull().default(1),
  variantOf: uuid("variant_of"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /** The version agents receive; null until one is approved. */
  approvedVersion: integer("approved_version"),
  /** Set when measurement shows the served version hurts outcomes; cleared by a review. */
  flaggedAt: timestamp("flagged_at", { withTimezone: true }),
  flagReason: text("flag_reason"),
});

export const skillVersions = pgTable(
  "skill_versions",
  {
    tenantId: uuid("tenant_id").notNull(),
    skillId: uuid("skill_id").notNull(),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    body: jsonb("body").$type<SkillDraftBody>().notNull(),
    evidence: jsonb("evidence").$type<{ success: string[]; failure: string[] }>().notNull(),
    gate: jsonb("gate").$type<Record<string, unknown>>().notNull(),
    sourceDraftId: uuid("source_draft_id"),
    createdAt: createdAt(),
    search: tsvector("search").generatedAlwaysAs(
      sql`to_tsvector('simple', mm_search_text(title || ' ' || body::text))`,
    ),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.skillId, t.version] })],
);

// Channels and review (migration 0011) ----------------------------------------------------------

export const SHARE_KINDS = ["intents", "summaries", "diffs_redacted", "messages"] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];

export const collabSettings = pgTable("collab_settings", {
  tenantId: uuid("tenant_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  crossTeamAllowed: boolean("cross_team_allowed").notNull().default(false),
  maxTtlMinutes: integer("max_ttl_minutes").notNull().default(480),
  allowedShare: text("allowed_share")
    .array()
    .$type<ShareKind[]>()
    .notNull()
    .default(["intents", "summaries", "messages"]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const collabPreapprovals = pgTable("collab_preapprovals", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  memberId: uuid("member_id").notNull(),
  sameTeamOnly: boolean("same_team_only").notNull().default(true),
  repo: text("repo"),
  share: text("share").array().$type<ShareKind[]>().notNull().default(["intents"]),
  createdAt: createdAt(),
});

export const CHANNEL_STATUSES = ["requested", "open", "closed", "expired", "rejected"] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];
export interface ChannelScope {
  resources: string[];
  share: ShareKind[];
  ttl_minutes: number;
}

export const channels = pgTable("channels", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  purposeRedacted: text("purpose_redacted").notNull(),
  scope: jsonb("scope").$type<ChannelScope>().notNull(),
  status: text("status", { enum: CHANNEL_STATUSES }).notNull().default("requested"),
  requestedBy: uuid("requested_by").notNull(),
  lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
  createdAt: createdAt(),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  closesAt: timestamp("closes_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closeReason: text("close_reason"),
});

export const channelParticipants = pgTable(
  "channel_participants",
  {
    tenantId: uuid("tenant_id").notNull(),
    channelId: uuid("channel_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    memberId: uuid("member_id").notNull(),
    approval: text("approval", { enum: ["pending", "approved", "declined"] })
      .notNull()
      .default("pending"),
    approvedVia: text("approved_via", { enum: ["web", "slack", "preapproval"] }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    deliveredSeq: bigint("delivered_seq", { mode: "number" }).notNull().default(0),
    deliveredStatus: text("delivered_status"),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.channelId, t.sessionId] })],
);

export const CHANNEL_MESSAGE_TYPES = [
  "intent_update",
  "proposal",
  "interface_change",
  "question",
  "answer",
  "handoff",
  "claim",
  "release",
  "note",
] as const;
export type ChannelMessageType = (typeof CHANNEL_MESSAGE_TYPES)[number];

export const channelMessages = pgTable(
  "channel_messages",
  {
    tenantId: uuid("tenant_id").notNull(),
    channelId: uuid("channel_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    id: uuid("id").notNull(),
    fromSession: uuid("from_session").notNull(),
    type: text("type", { enum: CHANNEL_MESSAGE_TYPES }).notNull(),
    bodyRedacted: text("body_redacted").notNull(),
    scan: jsonb("scan").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.channelId, t.seq] })],
);

export const leases = pgTable("leases", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  resource: text("resource").notNull(),
  holderSession: uuid("holder_session").notNull(),
  channelId: uuid("channel_id").notNull(),
  fencingToken: bigint("fencing_token", { mode: "number" })
    .notNull()
    .default(sql`nextval('lease_fencing_seq')`),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const agreements = pgTable(
  "agreements",
  {
    tenantId: uuid("tenant_id").notNull(),
    channelId: uuid("channel_id").notNull(),
    version: integer("version").notNull(),
    bodyRedacted: text("body_redacted").notNull(),
    proposedBy: uuid("proposed_by").notNull(),
    acceptedBy: uuid("accepted_by").array().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.channelId, t.version] })],
);

export const categoryOwners = pgTable(
  "category_owners",
  {
    tenantId: uuid("tenant_id").notNull(),
    memberId: uuid("member_id").notNull(),
    pack: text("pack").notNull(),
    category: text("category").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.memberId, t.pack, t.category] })],
);

export const REVIEW_ACTIONS = ["approve", "reject", "retire", "rollback", "restore"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export const skillReviews = pgTable("skill_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  skillId: uuid("skill_id").notNull(),
  version: integer("version").notNull(),
  action: text("action", { enum: REVIEW_ACTIONS }).notNull(),
  memberId: uuid("member_id"),
  note: text("note"),
  createdAt: createdAt(),
});

// Delivery, measurement, notifications, HubSpot, attribution (migration 0012) ----------

export const connectionSecrets = pgTable(
  "connection_secrets",
  {
    tenantId: uuid("tenant_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    kind: text("kind", { enum: ["refresh_token", "bot_token"] }).notNull(),
    sealed: text("sealed").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.connectionId, t.kind] })],
);

export interface SequenceCounts {
  enrolled: number;
  replied: number;
  meetings: number;
  as_of: string;
}

export const hubspotSequences = pgTable(
  "hubspot_sequences",
  {
    tenantId: uuid("tenant_id").notNull(),
    taskId: uuid("task_id").notNull(),
    connectionId: uuid("connection_id"),
    sequenceId: text("sequence_id").notNull(),
    ownerUserId: bigint("owner_user_id", { mode: "number" }),
    steps: integer("steps").notNull().default(0),
    emailSteps: integer("email_steps").notNull().default(0),
    taskSteps: integer("task_steps").notNull().default(0),
    createdAtHs: timestamp("created_at_hs", { withTimezone: true }).notNull(),
    updatedAtHs: timestamp("updated_at_hs", { withTimezone: true }).notNull(),
    counts: jsonb("counts").$type<Partial<SequenceCounts>>().notNull().default({}),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    metricsFinalAt: timestamp("metrics_final_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.taskId] })],
);

export const ATTRIBUTION_METHODS = ["reference", "heuristic"] as const;
/** Attributions below this confidence are kept but not used for learning or measurement. */
export const ATTRIBUTION_MIN_CONFIDENCE = 0.7;

export const taskAttributions = pgTable(
  "task_attributions",
  {
    tenantId: uuid("tenant_id").notNull(),
    taskId: uuid("task_id").notNull(),
    targetTaskId: uuid("target_task_id").notNull(),
    method: text("method", { enum: ATTRIBUTION_METHODS }).notNull(),
    confidence: real("confidence").notNull(),
    evidence: jsonb("evidence").$type<Record<string, number | string>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.taskId, t.targetTaskId] })],
);

export const skillSubscriptions = pgTable(
  "skill_subscriptions",
  {
    tenantId: uuid("tenant_id").notNull(),
    memberId: uuid("member_id").notNull(),
    pack: text("pack").notNull(),
    /** "*" means every category in the pack. */
    category: text("category").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.memberId, t.pack, t.category] })],
);

export const skillUsage = pgTable("skill_usage", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  skillId: uuid("skill_id").notNull(),
  version: integer("version").notNull(),
  taskId: uuid("task_id"),
  sessionId: uuid("session_id"),
  memberId: uuid("member_id").notNull(),
  agentIdentityId: uuid("agent_identity_id"),
  adherence: text("adherence", { enum: SKILL_ADHERENCE }).notNull().default("followed"),
  usedAt: timestamp("used_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const MEASUREMENT_STATUSES = ["insufficient", "no_effect", "improves", "degrades"] as const;
export type MeasurementStatus = (typeof MEASUREMENT_STATUSES)[number];

export const skillMeasurements = pgTable("skill_measurements", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  skillId: uuid("skill_id").notNull(),
  version: integer("version"),
  windowDays: integer("window_days").notNull(),
  usedN: integer("used_n").notNull(),
  usedSuccess: integer("used_success").notNull(),
  baseN: integer("base_n").notNull(),
  baseSuccess: integer("base_success").notNull(),
  lift: doublePrecision("lift"),
  ciLow: doublePrecision("ci_low"),
  ciHigh: doublePrecision("ci_high"),
  status: text("status", { enum: MEASUREMENT_STATUSES }).notNull(),
  measuredAt: timestamp("measured_at", { withTimezone: true }).notNull().defaultNow(),
});

export const NOTIFICATION_KINDS = [
  "channel_request",
  "skill_review",
  "skill_flagged",
  "skill_approved",
  "skill_retired",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  memberId: uuid("member_id").notNull(),
  kind: text("kind", { enum: NOTIFICATION_KINDS }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  status: text("status", { enum: ["pending", "sent", "skipped", "failed"] })
    .notNull()
    .default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: createdAt(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

/** A tenant's own version of a pack (the generic pack, in the MVP). Append-only. */
export const tenantPacks = pgTable(
  "tenant_packs",
  {
    tenantId: uuid("tenant_id").notNull(),
    packId: text("pack_id").notNull(),
    version: integer("version").notNull(),
    yaml: text("yaml").notNull(),
    createdByMemberId: uuid("created_by_member_id"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.packId, t.version] })],
);

export interface ImportProblem {
  line: number;
  problem: string;
}

export const outcomeImports = pgTable("outcome_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  memberId: uuid("member_id"),
  rows: integer("rows").notNull(),
  stored: integer("stored").notNull(),
  problems: jsonb("problems").$type<ImportProblem[]>().notNull().default([]),
  createdAt: createdAt(),
});

export interface EmailCounts {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  unsubscribed: number;
  as_of: string;
}

export const hubspotMarketingEmails = pgTable(
  "hubspot_marketing_emails",
  {
    tenantId: uuid("tenant_id").notNull(),
    taskId: uuid("task_id").notNull(),
    connectionId: uuid("connection_id"),
    emailId: text("email_id").notNull(),
    ownerUserId: bigint("owner_user_id", { mode: "number" }),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    counts: jsonb("counts").$type<Partial<EmailCounts>>().notNull().default({}),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    metricsFinalAt: timestamp("metrics_final_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.taskId] })],
);

export const hubspotDeals = pgTable(
  "hubspot_deals",
  {
    tenantId: uuid("tenant_id").notNull(),
    taskId: uuid("task_id").notNull(),
    connectionId: uuid("connection_id"),
    dealId: text("deal_id").notNull(),
    ownerUserId: bigint("owner_user_id", { mode: "number" }),
    pipeline: text("pipeline"),
    stage: text("stage"),
    dealType: text("deal_type"),
    createdAtHs: timestamp("created_at_hs", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    isClosed: boolean("is_closed").notNull().default(false),
    isWon: boolean("is_won").notNull().default(false),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    metricsFinalAt: timestamp("metrics_final_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.taskId] })],
);

export const TENANT_DELETION_STATUSES = ["scheduled", "cancelled", "purging", "purged"] as const;

export const tenantDeletions = pgTable("tenant_deletions", {
  tenantId: uuid("tenant_id").primaryKey(),
  requestedByMemberId: uuid("requested_by_member_id").notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  purgeAfter: timestamp("purge_after", { withTimezone: true }).notNull(),
  status: text("status", { enum: TENANT_DELETION_STATUSES }).notNull().default("scheduled"),
  steps: jsonb("steps").$type<Record<string, string>>().notNull().default({}),
  purgedAt: timestamp("purged_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
  githubPrLinks,
  judgments,
  skillDrafts,
  intents,
  sessionOverlaps,
  skills,
  skillVersions,
  collabSettings,
  collabPreapprovals,
  channels,
  channelParticipants,
  channelMessages,
  leases,
  agreements,
  categoryOwners,
  skillReviews,
  connectionSecrets,
  hubspotSequences,
  taskAttributions,
  skillSubscriptions,
  skillUsage,
  skillMeasurements,
  notifications,
  tenantPacks,
  outcomeImports,
  hubspotMarketingEmails,
  hubspotDeals,
  tenantDeletions,
};
