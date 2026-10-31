import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  parseInteraction,
  renderNotification,
  respond,
  signSlackRequest,
  verifySlackRequest,
} from "../src/index.ts";

const SECRET = "signing-secret";

describe("verifySlackRequest", () => {
  const body = "payload=%7B%7D";
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  it("accepts Slack's signature and refuses anything else", () => {
    const signature = signSlackRequest(SECRET, Number(ts), body);
    expect(verifySlackRequest(SECRET, { timestamp: ts, signature }, body, now)).toBe(true);
    expect(verifySlackRequest("other", { timestamp: ts, signature }, body, now)).toBe(false);
    expect(verifySlackRequest(SECRET, { timestamp: ts, signature }, `${body}x`, now)).toBe(false);
    expect(verifySlackRequest(SECRET, { timestamp: ts, signature: "v0=00" }, body, now)).toBe(
      false,
    );
    expect(verifySlackRequest(SECRET, { timestamp: ts }, body, now)).toBe(false);
  });
  it("refuses requests more than five minutes old (replays)", () => {
    const old = String(now / 1000 - 301);
    const signature = signSlackRequest(SECRET, Number(old), body);
    expect(verifySlackRequest(SECRET, { timestamp: old, signature }, body, now)).toBe(false);
  });
});

describe("renderNotification", () => {
  it("puts approve and decline buttons on channel requests", () => {
    const m = renderNotification(
      "channel_request",
      {
        channel_id: "c1",
        purpose: "agree on step 2",
        requester: "Lior",
        share: ["intents"],
        ttl_minutes: 60,
        resources: [],
      },
      "https://mm.test/",
    );
    const actions = m.blocks.find((b) => b.type === "actions") as {
      elements: { action_id?: string; value?: string; url?: string }[];
    };
    expect(actions.elements.map((e) => e.action_id ?? e.url)).toEqual([
      ACTIONS.approve,
      ACTIONS.decline,
      "https://mm.test/channels",
    ]);
    expect(m.text).toContain("Lior's agent wants to open a channel");
  });
  it("escapes text, so agent-written words can't become links or mentions", () => {
    const m = renderNotification(
      "channel_request",
      { channel_id: "c", purpose: "<!channel> see <https://evil.test|docs>", requester: "x" },
      "https://mm.test",
    );
    const text = JSON.stringify(m.blocks);
    expect(text).not.toContain("<!channel>");
    expect(text).not.toContain("<https://evil.test");
    expect(text).toContain("&lt;!channel&gt;");
  });
});

describe("interactions", () => {
  it("parses Slack's form body", () => {
    expect(parseInteraction(`payload=${encodeURIComponent('{"type":"block_actions"}')}`)).toEqual({
      type: "block_actions",
    });
    expect(parseInteraction("payload=not-json")).toBeNull();
    expect(parseInteraction("x=1")).toBeNull();
  });
  it("only answers through Slack's own response URLs", async () => {
    expect(await respond({ text: "x", responseUrl: "https://evil.test/hook" })).toBe(false);
    expect(await respond({ text: "x", responseUrl: "not a url" })).toBe(false);
    expect(await respond({ text: "x", responseUrl: null })).toBe(false);
  });
});
