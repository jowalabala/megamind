// The gateway protocol: small JSON messages over one WebSocket per agent session.
import { z } from "zod";

export const clientMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    session: z.object({
      id: z.string().min(1).max(200),
      repo: z.string().max(500).optional(),
      branch: z.string().max(300).optional(),
      tool: z.string().max(100).optional(),
      private: z.boolean().optional(),
    }),
  }),
  z.object({ type: z.literal("heartbeat") }),
  z.object({ type: z.literal("bye") }),
]);
export type ClientMessage = z.infer<typeof clientMessage>;

export const presenceEntry = z.object({
  session_id: z.string(),
  /** "you", a name, "someone on <team>", or "a teammate" (the author's visibility rules). */
  who: z.string(),
  you: z.boolean(),
  tool: z.string().nullable(),
  repo: z.string().nullable(),
  /** Only shown to people on the same team. */
  branch: z.string().nullable(),
  since: z.string(),
  last_seen: z.string(),
});
export type PresenceEntry = z.infer<typeof presenceEntry>;

export type ServerMessage =
  | { type: "welcome"; session_id: string }
  | { type: "presence"; sessions: PresenceEntry[] }
  | { type: "error"; code: string; message: string };

/** Close codes (4000-4999 are application-defined). */
export const CLOSE = {
  unauthorized: 4001,
  optedOut: 4003,
  badMessage: 4004,
  rateLimited: 4008,
  replaced: 4009,
} as const;

export const HEARTBEAT_MS = 30_000;
/** A session is present if it sent anything within this window. */
export const PRESENCE_TTL_MS = 60_000;
