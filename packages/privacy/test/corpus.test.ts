// Scores the deterministic redaction layers against the labelled corpus.
// Recall: every labelled value is gone from the output. Precision: every "keep" string survives.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createDirectoryDetector, createRedactor } from "../src/index.ts";
import { expand } from "./generate.ts";

interface Entry {
  id: string;
  text: string;
  expect: { label: string; value: string }[];
  keep?: string[];
  requires?: "comprehend";
  note?: string;
}

const corpus: Entry[] = readFileSync(new URL("../corpus/corpus.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

export const DIRECTORY = [
  { id: "m-dana", emails: ["dana.levi@acme.test"], names: ["Dana Levi"], handles: ["danalevi"] },
  { id: "m-lior", emails: ["lior@acme.test"], names: ["Lior Ben-David"], handles: ["lior-bd"] },
  { id: "m-priya", emails: ["priya.raman@acme.test"], names: ["Priya Raman"], handles: ["priyar"] },
];

const redactor = createRedactor({
  detectors: [createDirectoryDetector(DIRECTORY, { key: "corpus-test-key" })],
});

const PII_LABELS = new Set([
  "person",
  "email",
  "phone",
  "card",
  "ssn",
  "iban",
  "ip",
  "name",
  "address",
]);
const categoryOf = (label: string) => (PII_LABELS.has(label) ? "pii" : "secret");

function score() {
  const tally = { secret: { hit: 0, total: 0 }, pii: { hit: 0, total: 0 } };
  const misses: string[] = [];
  const falsePositives: string[] = [];
  const notIdempotent: string[] = [];
  let keepTotal = 0;
  for (const e of corpus) {
    if (e.requires === "comprehend") continue;
    const cache = new Map<string, string>();
    const text = expand(e.text, cache, e.id);
    const out = redactor.redactSync(text).text;
    // The bridge redacts first and the server again: a second pass must change nothing.
    if (redactor.redactSync(out).text !== out) notIdempotent.push(e.id);
    for (const span of e.expect) {
      const value = expand(span.value, cache, e.id);
      const cat = categoryOf(span.label);
      tally[cat].total++;
      if (out.includes(value))
        misses.push(`${e.id} (${span.label})${e.note ? ` [${e.note}]` : ""}`);
      else tally[cat].hit++;
    }
    for (const k of e.keep ?? []) {
      keepTotal++;
      if (!out.includes(expand(k, cache, e.id)))
        falsePositives.push(`${e.id}: ${JSON.stringify(out)}`);
    }
  }
  return { tally, misses, falsePositives, notIdempotent, keepTotal };
}

describe("labelled corpus (deterministic layers)", () => {
  const r = score();
  const recall = (c: { hit: number; total: number }) => c.hit / c.total;

  it("has enough labelled data to mean something", () => {
    expect(r.tally.secret.total).toBeGreaterThanOrEqual(40);
    expect(r.tally.pii.total).toBeGreaterThanOrEqual(35);
    expect(r.keepTotal).toBeGreaterThanOrEqual(60);
  });

  it("secret recall >= 0.95", () => {
    expect(recall(r.tally.secret), r.misses.join("\n")).toBeGreaterThanOrEqual(0.95);
  });

  it("PII recall >= 0.95 (names and addresses outside the directory need Comprehend)", () => {
    expect(recall(r.tally.pii), r.misses.join("\n")).toBeGreaterThanOrEqual(0.95);
  });

  it("redacting already-redacted text changes nothing", () => {
    expect(r.notIdempotent).toEqual([]);
  });

  it("false positives <= 5% of strings that must survive", () => {
    expect(r.falsePositives.length / r.keepTotal, r.falsePositives.join("\n")).toBeLessThanOrEqual(
      0.05,
    );
  });

  it("prints the scorecard", () => {
    console.info(
      `redaction corpus: secrets ${r.tally.secret.hit}/${r.tally.secret.total}, ` +
        `pii ${r.tally.pii.hit}/${r.tally.pii.total}, ` +
        `false positives ${r.falsePositives.length}/${r.keepTotal}` +
        (r.misses.length ? `\n  misses:\n    ${r.misses.join("\n    ")}` : "") +
        (r.falsePositives.length
          ? `\n  false positives:\n    ${r.falsePositives.join("\n    ")}`
          : ""),
    );
  });
});
