import { describe, expect, it, vi } from "vitest";
import { comprehendDetector } from "../src/comprehend.ts";
import { createDirectoryDetector, createRedactor, pseudonym } from "../src/index.ts";
import { expand } from "./generate.ts";

const fake = (name: string) => expand(`{{${name}}}`, new Map(), "unit");

describe("redact", () => {
  const r = createRedactor();

  it("replaces secrets and PII with typed placeholders and counts them", () => {
    const token = fake("github_token");
    const out = r.redactSync(`token ${token} from jane@example.com`);
    expect(out.text).toBe("token [SECRET:github_token] from [EMAIL]");
    expect(out.counts).toEqual({ "secret:github_token": 1, "pii:email": 1 });
  });

  it("an email inside a connection string is not double-replaced", () => {
    const out = r.redactSync("postgres://bob:Sup3rS3cret!x@db.internal/app");
    expect(out.text).toBe("postgres://bob:[SECRET:url_password]@db.internal/app");
  });

  it("leaves ordinary text alone", () => {
    const text = "Refactor computeTotal to support proration; add unit tests.";
    expect(r.redactSync(text)).toEqual({ text, counts: {} });
  });

  it("finishes quickly on large adversarial input", () => {
    const evil = "password=" + "a".repeat(50_000) + " " + "1-".repeat(50_000) + "@".repeat(20_000);
    const t0 = performance.now();
    r.redactSync(evil);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});

describe("directory pseudonyms", () => {
  const dir = createDirectoryDetector(
    [{ id: "m1", emails: ["dana@acme.test"], names: ["Dana Levi"], handles: ["danalevi"] }],
    { key: "tenant-key" },
  );
  const r = createRedactor({ detectors: [dir] });

  it("gives the same person the same pseudonym across name, email and handle", () => {
    const p = `[PERSON:${pseudonym("tenant-key", "m1")}]`;
    expect(r.redactSync("Dana Levi <dana@acme.test> aka @danalevi").text).toBe(
      `${p} <${p}> aka ${p}`,
    );
  });

  it("pseudonyms differ between tenants", () => {
    expect(pseudonym("tenant-a", "m1")).not.toBe(pseudonym("tenant-b", "m1"));
  });

  it("does not match inside other words or emails", () => {
    expect(r.redactSync("xDana Levix and notdana@acme.test.org").text).not.toContain("PERSON");
  });
});

describe("redactValue", () => {
  it("walks JSON, removes values under secret-like keys, keeps numbers", async () => {
    const r = createRedactor();
    const { value, counts } = await r.redactValue({
      title: "Email jane@example.com",
      headers: { Authorization: "anything at all", "x-request-id": "abc" },
      usage: { input_tokens: 1200 },
      list: ["ok", "call +1 415 555 0134"],
    });
    expect(value).toEqual({
      title: "Email [EMAIL]",
      headers: { Authorization: "[SECRET:by_key]", "x-request-id": "abc" },
      usage: { input_tokens: 1200 },
      list: ["ok", "call [PHONE]"],
    });
    expect(counts).toEqual({ "pii:email": 1, "secret:by_key": 1, "pii:phone": 1 });
  });
});

describe("external detector (Comprehend)", () => {
  it("only sees text after deterministic redaction, and never re-redacts placeholders", async () => {
    const send = vi.fn(async (cmd: { input: { Text: string } }) => {
      const text = cmd.input.Text;
      const begin = text.indexOf("Sam Patel");
      return {
        Entities: [
          { Type: "NAME", Score: 0.99, BeginOffset: begin, EndOffset: begin + 9 },
          // Comprehend flagging our own placeholder must be ignored.
          {
            Type: "EMAIL",
            Score: 0.9,
            BeginOffset: text.indexOf("[EMAIL]"),
            EndOffset: text.indexOf("[EMAIL]") + 7,
          },
          { Type: "DATE_TIME", Score: 0.99, BeginOffset: 0, EndOffset: 3 },
          { Type: "ADDRESS", Score: 0.5, BeginOffset: 0, EndOffset: 3 },
        ],
      };
    });
    const r = createRedactor({ external: comprehendDetector({ client: { send } as never }) });
    const token = fake("stripe_key");
    const out = await r.redact(`Lead Sam Patel sam@initech.test key ${token}`);
    expect(send).toHaveBeenCalledOnce();
    const sent = send.mock.calls[0]![0].input.Text;
    expect(sent).not.toContain(token);
    expect(sent).not.toContain("sam@initech.test");
    expect(out.text).toBe("Lead [NAME] [EMAIL] key [SECRET:stripe_key]");
    expect(out.counts).toEqual({ "pii:email": 1, "secret:stripe_key": 1, "pii:name": 1 });
  });

  it("maps code point offsets to JavaScript string offsets", async () => {
    const text = "🙂🙂 Sam Patel";
    const send = vi.fn(async () => ({
      Entities: [{ Type: "NAME", Score: 0.99, BeginOffset: 3, EndOffset: 12 }],
    }));
    const d = comprehendDetector({ client: { send } as never });
    const [found] = await d.detect(text);
    expect(text.slice(found!.start, found!.end)).toBe("Sam Patel");
  });
});
