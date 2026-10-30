// Typed mirror of the SQL migrations in ../migrations, which are the source of truth.
// test/schema-drift.test.ts fails if the two disagree.
import {
  bigint,
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const memberRole = pgEnum("member_role", ["admin", "category_owner", "member"]);
export const visibilityPref = pgEnum("visibility_pref", ["name", "team", "anonymous"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  workosOrgId: text("workos_org_id").unique(),
  region: text("region").notNull().default("us-east-1"),
  kmsKeyArn: text("kms_key_arn"),
  createdAt: createdAt(),
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

/** Every Drizzle table, used by the drift test. */
export const allTables = {
  tenants,
  teams,
  members,
  teamMembers,
  auditEvents,
  auditChainHeads,
  llmCalls,
};
