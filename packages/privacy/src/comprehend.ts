// Optional AWS Comprehend layer for PII the deterministic rules can't see, mainly names
// and postal addresses of people outside the tenant directory.
// It receives text only after secrets and known PII have been replaced.
import { ComprehendClient, DetectPiiEntitiesCommand } from "@aws-sdk/client-comprehend";
import type { AsyncDetector, Detection } from "./types.ts";

/** Comprehend entity types we remove, mapped to our labels. Others (DATE_TIME, URL, AGE...) are kept. */
const LABELS: Record<string, string> = {
  NAME: "name",
  ADDRESS: "address",
  EMAIL: "email",
  PHONE: "phone",
  SSN: "ssn",
  CREDIT_DEBIT_NUMBER: "card",
  CREDIT_DEBIT_CVV: "card",
  BANK_ACCOUNT_NUMBER: "id",
  BANK_ROUTING: "id",
  INTERNATIONAL_BANK_ACCOUNT_NUMBER: "iban",
  PASSPORT_NUMBER: "id",
  DRIVER_ID: "id",
  PASSWORD: "pii",
  PIN: "pii",
  IP_ADDRESS: "ip",
};
const SECRET_LABELS: Record<string, string> = {
  AWS_ACCESS_KEY: "aws_access_key_id",
  AWS_SECRET_KEY: "aws_secret_key",
};

/** Comprehend accepts up to 100 KB of UTF-8 per call; 20k code points is always under that. */
const CHUNK_CODE_POINTS = 20_000;

export interface ComprehendDetectorOptions {
  client?: Pick<ComprehendClient, "send">;
  region?: string;
  minScore?: number;
  languageCode?: "en" | "es" | "fr" | "de" | "it" | "pt";
}

/** Comprehend reports offsets in code points; JavaScript strings index UTF-16 units. */
function codePointToUtf16(text: string): (cp: number) => number {
  const map: number[] = [];
  let unit = 0;
  for (const ch of text) {
    map.push(unit);
    unit += ch.length;
  }
  map.push(unit);
  return (cp) => map[Math.min(cp, map.length - 1)]!;
}

export function comprehendDetector(options: ComprehendDetectorOptions = {}): AsyncDetector {
  const client = options.client ?? new ComprehendClient({ region: options.region });
  const minScore = options.minScore ?? 0.8;
  return {
    name: "comprehend",
    async detect(text) {
      const cps = Array.from(text);
      const out: Detection[] = [];
      let unitOffset = 0;
      for (let i = 0; i < cps.length; i += CHUNK_CODE_POINTS) {
        const chunk = cps.slice(i, i + CHUNK_CODE_POINTS).join("");
        const toUnit = codePointToUtf16(chunk);
        const res = await client.send(
          new DetectPiiEntitiesCommand({ Text: chunk, LanguageCode: options.languageCode ?? "en" }),
        );
        for (const e of res.Entities ?? []) {
          if ((e.Score ?? 0) < minScore || e.BeginOffset == null || e.EndOffset == null) continue;
          const type = e.Type ?? "";
          const secret = SECRET_LABELS[type];
          const label = secret ?? LABELS[type];
          if (!label) continue;
          out.push({
            start: unitOffset + toUnit(e.BeginOffset),
            end: unitOffset + toUnit(e.EndOffset),
            category: secret ? "secret" : "pii",
            label,
          });
        }
        unitOffset += chunk.length;
      }
      return out;
    },
  };
}
