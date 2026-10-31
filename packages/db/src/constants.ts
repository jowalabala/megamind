// Plain constants shared with packages that must not pull in Postgres (the bridge, MCP tools).
export const AGENT_KINDS = [
  "claude_code",
  "cursor",
  "chatgpt",
  "copilot",
  "custom",
  "bridge",
] as const;

export const AGENT_SCOPES = ["capture:write", "history:read", "skills:read", "collab"] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];
/** What a new key gets unless the creator picks otherwise. */
export const DEFAULT_AGENT_SCOPES: AgentScope[] = [
  "capture:write",
  "history:read",
  "skills:read",
  "collab",
];

export const ARTIFACT_KINDS = ["text", "diff", "email", "document", "link", "other"] as const;

/** Where captured data came from. Mirrors the capture_source enum. */
export const CAPTURE_SOURCES = ["mcp", "bridge", "github", "hubspot", "csv", "ui"] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

/** How a task's category was decided. */
export const CATEGORY_SOURCES = ["rule", "hint", "llm", "fallback"] as const;
export type CategorySource = (typeof CATEGORY_SOURCES)[number];

/** How closely an agent followed a skill. Mirrors skill_usage.adherence. */
export const SKILL_ADHERENCE = ["followed", "partial", "consulted"] as const;
export type SkillAdherence = (typeof SKILL_ADHERENCE)[number];
