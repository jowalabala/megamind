// Builds realistic-looking fake secrets for the corpus at test time, so no secret-shaped
// strings are committed (they would trip GitHub push protection and secret scanners).
import { createHash } from "node:crypto";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER_NUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const HEX = "0123456789abcdef";
const B64 = ALNUM + "+/";
const B64URL = ALNUM + "-_";

/** Deterministic random characters, seeded by name, so failures are reproducible. */
function chars(seed: string, alphabet: string, n: number): string {
  let out = "";
  let block = Buffer.alloc(0);
  let counter = 0;
  while (out.length < n) {
    if (block.length === 0) {
      block = createHash("sha256").update(`${seed}:${counter++}`).digest();
    }
    out += alphabet[block[0]! % alphabet.length];
    block = block.subarray(1);
  }
  return out;
}

const b64url = (s: string) => Buffer.from(s).toString("base64url");

const GENERATORS: Record<string, (seed: string) => string> = {
  aws_key: (s) => "AKIA" + chars(s, UPPER_NUM, 16),
  aws_secret: (s) => chars(s, B64, 40),
  github_token: (s) => "ghp_" + chars(s, ALNUM, 36),
  github_pat: (s) => "github_pat_" + chars(s, ALNUM, 22) + "_" + chars(s + "b", ALNUM, 59),
  gitlab_token: (s) => "glpat-" + chars(s, B64URL, 20),
  slack_token: (s) =>
    `xoxb-${chars(s, "0123456789", 12)}-${chars(s + "b", "0123456789", 13)}-${chars(s + "c", ALNUM, 24)}`,
  slack_webhook: (s) =>
    `https://hooks.slack.com/services/T${chars(s, UPPER_NUM, 8)}/B${chars(s + "b", UPPER_NUM, 10)}/${chars(s + "c", ALNUM, 24)}`,
  stripe_key: (s) => "sk_live_" + chars(s, ALNUM, 24),
  anthropic_key: (s) => "sk-ant-api03-" + chars(s, B64URL, 95),
  openai_key: (s) => "sk-proj-" + chars(s, B64URL, 48),
  google_key: (s) => "AIza" + chars(s, B64URL, 35),
  npm_token: (s) => "npm_" + chars(s, ALNUM, 36),
  hubspot_token: (s) => {
    const h = chars(s, HEX, 32);
    return `pat-na1-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  },
  sendgrid_key: (s) => `SG.${chars(s, B64URL, 22)}.${chars(s + "b", B64URL, 43)}`,
  twilio_key: (s) => "SK" + chars(s, HEX, 32),
  mm_key: (s) => "mm_live_" + chars(s, ALNUM, 40),
  azure_key: (s) => chars(s, B64, 86) + "==",
  jwt: (s) =>
    `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url(`{"sub":"${chars(s, HEX, 12)}","exp":1893456000}`)}.${chars(s + "sig", B64URL, 43)}`,
  bearer: (s) => chars(s, B64URL, 40),
  password: (s) =>
    chars(s, ALNUM, 6) + "!" + chars(s + "d", "0123456789", 2) + chars(s + "x", ALNUM, 5),
  private_key: (s) =>
    "-----BEGIN RSA PRIVATE KEY-----\n" +
    Array.from({ length: 6 }, (_, i) => chars(`${s}${i}`, B64, 64)).join("\n") +
    "\n-----END RSA PRIVATE KEY-----",
  // A key pasted without its END line.
  private_key_open: (s) =>
    "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
    Array.from({ length: 4 }, (_, i) => chars(`${s}${i}`, B64, 70)).join("\n"),
};

/** Replaces {{name}} / {{name:n}} with fake values; the same placeholder gets the same value. */
export function expand(template: string, cache: Map<string, string>, seed: string): string {
  return template.replace(/\{\{(\w+)(?::(\d+))?\}\}/g, (whole, name: string, n?: string) => {
    const gen = GENERATORS[name];
    if (!gen) throw new Error(`Unknown corpus generator ${name}`);
    let v = cache.get(whole);
    if (v === undefined) cache.set(whole, (v = gen(`${seed}:${name}:${n ?? "1"}`)));
    return v;
  });
}
