// Secret rules, adapted from common gitleaks patterns. Every rule is anchored and uses
// bounded quantifiers so no input can make a regex run for long.
import type { Detection, Detector } from "./types.ts";

interface Rule {
  label: string;
  re: RegExp;
  /** Capture group to remove instead of the whole match. */
  group?: number;
  /** Extra check on the removed value. */
  accept?: (value: string, match: RegExpExecArray) => boolean;
}

const TOKEN_CHARS = "[A-Za-z0-9_-]";

const RULES: Rule[] = [
  {
    label: "private_key",
    re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  { label: "aws_access_key_id", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { label: "github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_\w{22,255})\b/g },
  { label: "gitlab_token", re: new RegExp(`\\bglpat-${TOKEN_CHARS}{20,}`, "g") },
  { label: "slack_token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,250}/g },
  { label: "slack_webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{10,200}/g },
  { label: "stripe_key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,247}\b/g },
  { label: "stripe_webhook_secret", re: /\bwhsec_[A-Za-z0-9]{24,}\b/g },
  { label: "anthropic_key", re: new RegExp(`\\bsk-ant-${TOKEN_CHARS}{20,300}`, "g") },
  {
    label: "openai_key",
    re: new RegExp(`\\bsk-(?:proj-|svcacct-|admin-)?${TOKEN_CHARS}{20,300}`, "g"),
  },
  { label: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { label: "google_oauth_secret", re: /\bGOCSPX-[A-Za-z0-9_-]{28}(?![A-Za-z0-9_-])/g },
  { label: "npm_token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    label: "hubspot_token",
    re: /\bpat-(?:na|eu|ap)\d-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
  },
  { label: "sendgrid_key", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g },
  { label: "twilio_key", re: /\bSK[0-9a-fA-F]{32}\b/g },
  { label: "mastermind_key", re: /\bmm_(?:live|test)_[A-Za-z0-9_]{20,200}\b/g },
  {
    label: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{8,4000}\.eyJ[A-Za-z0-9_-]{8,8000}\.[A-Za-z0-9_-]{8,2000}(?![A-Za-z0-9_-])/g,
  },
  {
    // scheme://user:password@host keeps the user and host, removes the password.
    label: "url_password",
    re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]{1,200}:([^\s@/]{1,200})@/gi,
    group: 1,
  },
  {
    label: "authorization_header",
    re: /\b(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{16,4000})/g,
    group: 1,
  },
  { label: "azure_storage_key", re: /\bAccountKey=([A-Za-z0-9+/=]{20,200})/g, group: 1 },
  {
    // password = "anything" (quoted values are taken as written)
    label: "keyword_secret",
    re: /(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|credentials?|private[_-]?key)[\w.-]{0,40}["']?\s{0,3}(?::=|=>|[:=])\s{0,3}(["'`])([^"'`\r\n]{4,500})\1/gi,
    group: 2,
    accept: (v) => !isPlaceholder(v),
  },
  {
    // password=Hunter2! (unquoted values must look like a secret, not a type or variable name)
    label: "keyword_secret",
    re: /(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|credentials?|private[_-]?key)[\w.-]{0,40}\s{0,3}(?::=|=>|[:=])\s{0,3}([^\s"'`,;()<>{}[\]]{8,500})/gi,
    group: 1,
    accept: (v) => looksLikeSecret(v),
  },
];

function isPlaceholder(v: string): boolean {
  return /^(?:\*+|x+|\.{3}|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|changeme|redacted|null|undefined|none)$/i.test(
    v.trim(),
  );
}

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** True for values like "Hunter2!x" or "wJalrXUtnFEMI/K7MDENG", false for "process.env.TOKEN" or "string". */
export function looksLikeSecret(v: string): boolean {
  if (isPlaceholder(v)) return false;
  // A dotted identifier path is a reference, not a value.
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v)) return false;
  const classes =
    Number(/[a-z]/.test(v)) +
    Number(/[A-Z]/.test(v)) +
    Number(/\d/.test(v)) +
    Number(/[^A-Za-z0-9]/.test(v));
  if (classes < 2) return false;
  return shannonEntropy(v) >= 2.8;
}

export const secretDetector: Detector = {
  name: "secrets",
  detect(text) {
    const out: Detection[] = [];
    for (const rule of RULES) {
      const re = new RegExp(rule.re.source, rule.re.flags + "d");
      for (const m of text.matchAll(re)) {
        const idx = m.indices?.[rule.group ?? 0];
        const value = m[rule.group ?? 0];
        if (!idx || value === undefined) continue;
        if (rule.accept && !rule.accept(value, m)) continue;
        out.push({ start: idx[0], end: idx[1], category: "secret", label: rule.label });
      }
    }
    return out;
  },
};
