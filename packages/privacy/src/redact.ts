import { piiDetector } from "./pii.ts";
import { secretDetector } from "./secrets.ts";
import type { AsyncDetector, Detection, Detector, RedactionResult } from "./types.ts";

export interface RedactorOptions {
  /** Extra deterministic detectors, e.g. the tenant directory. */
  detectors?: Detector[];
  /** External PII service (e.g. AWS Comprehend). Sees text only after deterministic redaction. */
  external?: AsyncDetector;
}

export interface Redactor {
  redact(text: string): Promise<RedactionResult>;
  /** Deterministic layers only. Used by the local bridge and where no network call is allowed. */
  redactSync(text: string): RedactionResult;
  /** Redacts every string in a JSON value. Values under secret-looking keys are removed whole. */
  redactValue<T>(value: T): Promise<{ value: T; counts: Record<string, number> }>;
}

const PLACEHOLDER_RE =
  /\[(?:SECRET|PERSON|EMAIL|PHONE|CARD|SSN|IBAN|IP|NAME|ADDRESS|ID|PII)(?::[\w-]+)?\]/g;

// Secrets beat people, people beat generic PII; then the longer span wins.
const priority = (d: Detection) => (d.category === "secret" ? 3 : d.label === "person" ? 2 : 1);

function placeholder(d: Detection): string {
  if (d.replacement) return d.replacement;
  return d.category === "secret" ? `[SECRET:${d.label}]` : `[${d.label.toUpperCase()}]`;
}

/** Picks non-overlapping detections and replaces them. */
export function applyDetections(text: string, detections: Detection[]): RedactionResult {
  const sorted = [...detections]
    .filter((d) => d.end > d.start)
    .sort(
      (a, b) =>
        priority(b) - priority(a) || b.end - b.start - (a.end - a.start) || a.start - b.start,
    );
  const chosen: Detection[] = [];
  for (const d of sorted) {
    if (chosen.every((c) => d.end <= c.start || d.start >= c.end)) chosen.push(d);
  }
  chosen.sort((a, b) => a.start - b.start);

  const counts: Record<string, number> = {};
  let out = "";
  let pos = 0;
  for (const d of chosen) {
    out += text.slice(pos, d.start) + placeholder(d);
    pos = d.end;
    const key = `${d.category}:${d.label}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { text: out + text.slice(pos), counts };
}

export function mergeCounts(...all: Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of all) for (const [k, v] of Object.entries(c)) out[k] = (out[k] ?? 0) + v;
  return out;
}

const SENSITIVE_KEY_RE =
  /(?:^|[_-])(?:password|passwd|passphrase|secret|token|api[_-]?key|apikey|authorization|cookie|set-cookie|private[_-]?key|client[_-]?secret|credentials?)$/i;

export function createRedactor(options: RedactorOptions = {}): Redactor {
  const detectors = [secretDetector, piiDetector, ...(options.detectors ?? [])];

  function redactSync(text: string): RedactionResult {
    if (!text) return { text, counts: {} };
    return applyDetections(
      text,
      detectors.flatMap((d) => d.detect(text)),
    );
  }

  async function redact(text: string): Promise<RedactionResult> {
    const first = redactSync(text);
    if (!options.external || !first.text) return first;
    const found = await options.external.detect(first.text);
    // Never re-redact our own placeholders.
    const protectedSpans = [...first.text.matchAll(PLACEHOLDER_RE)].map((m) => [
      m.index,
      m.index + m[0].length,
    ]);
    const fresh = found.filter((d) =>
      protectedSpans.every(([s, e]) => d.end <= s! || d.start >= e!),
    );
    const second = applyDetections(first.text, fresh);
    return { text: second.text, counts: mergeCounts(first.counts, second.counts) };
  }

  async function redactValue<T>(value: T): Promise<{ value: T; counts: Record<string, number> }> {
    let counts: Record<string, number> = {};
    async function walk(v: unknown, key?: string): Promise<unknown> {
      if (typeof v === "string") {
        if (key && SENSITIVE_KEY_RE.test(key) && v.length > 0) {
          counts = mergeCounts(counts, { "secret:by_key": 1 });
          return "[SECRET:by_key]";
        }
        const r = await redact(v);
        counts = mergeCounts(counts, r.counts);
        return r.text;
      }
      if (Array.isArray(v)) {
        const out = [];
        for (const item of v) out.push(await walk(item, key));
        return out;
      }
      if (v && typeof v === "object" && !(v instanceof Date)) {
        const out: Record<string, unknown> = {};
        for (const [k, inner] of Object.entries(v)) out[k] = await walk(inner, k);
        return out;
      }
      return v;
    }
    const out = (await walk(value)) as T;
    return { value: out, counts };
  }

  return { redact, redactSync, redactValue };
}
