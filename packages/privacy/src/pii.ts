// Deterministic PII rules. Each pattern is paired with a validator (Luhn, mod-97, digit
// counts) so ordinary numbers, dates and IDs are left alone.
import type { Detection, Detector } from "./types.ts";

const FILE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "ico",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "json",
  "css",
  "scss",
  "html",
  "md",
  "yml",
  "yaml",
  "lock",
  "map",
  "txt",
]);

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Known card number prefixes and lengths (Visa, Mastercard, Amex, Discover, JCB, Diners). */
function cardShape(d: string): boolean {
  const n = d.length;
  if (/^4/.test(d)) return n === 13 || n === 16 || n === 19;
  if (/^(?:5[1-5]|2(?:2[2-9]|[3-6]\d|7[01]|720))/.test(d)) return n === 16;
  if (/^3[47]/.test(d)) return n === 15;
  if (/^(?:6011|65|64[4-9])/.test(d)) return n >= 16 && n <= 19;
  if (/^35(?:2[89]|[3-8]\d)/.test(d)) return n >= 16 && n <= 19;
  if (/^3(?:0[0-5]|[689])/.test(d)) return n === 14;
  return false;
}

function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s/g, "").toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of v) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem === 1;
}

interface Rule {
  label: string;
  re: RegExp;
  accept?: (value: string) => boolean;
}

const RULES: Rule[] = [
  {
    label: "email",
    re: /(?<![\w.%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}\b/g,
    accept: (v) => !FILE_EXTENSIONS.has(v.slice(v.lastIndexOf(".") + 1).toLowerCase()),
  },
  {
    label: "card",
    re: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g,
    accept: (v) => {
      const d = v.replace(/\D/g, "");
      return cardShape(d) && luhn(d);
    },
  },
  {
    label: "ssn",
    re: /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g,
  },
  {
    label: "iban",
    re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g,
    accept: ibanValid,
  },
  {
    // International or national numbers with separators, e.g. +1 (415) 555-0134, 020 7946 0958.
    label: "phone",
    re: /(?<![\w.:/#=+-])(?:\+\d{1,3}[ .-]?|\d{1,3}[ .-])?(?:\(\d{1,4}\)[ .-]?)?\d{2,4}(?:[ .-]?\d{2,4}){1,4}(?![\w.-]*\d)/g,
    accept: (v) => {
      const digits = v.replace(/\D/g, "");
      if (digits.length < 10 || digits.length > 15) return false;
      // Plain digit runs are IDs or timestamps unless written in international form.
      if (/^\d+$/.test(v)) return false;
      // Dates and times.
      if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}/.test(v) || /^\d{1,2}[-./]\d{1,2}[-./]\d{2,4}/.test(v)) {
        return false;
      }
      // Dotted quads are IP addresses, handled separately.
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(v)) return false;
      return true;
    },
  },
  {
    label: "ip",
    re: /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\.?\d)(?![\w])/g,
    accept: (v) => !/^(?:127\.|0\.0\.0\.0$)/.test(v),
  },
];

export const piiDetector: Detector = {
  name: "pii",
  detect(text) {
    const out: Detection[] = [];
    for (const rule of RULES) {
      for (const m of text.matchAll(rule.re)) {
        let value = m[0];
        // Trailing separators belong to the sentence, not the number.
        const trimmed = value.replace(/[ .-]+$/, "");
        value = trimmed;
        if (rule.accept && !rule.accept(value)) continue;
        out.push({
          start: m.index,
          end: m.index + value.length,
          category: "pii",
          label: rule.label,
        });
      }
    }
    return out;
  },
};
