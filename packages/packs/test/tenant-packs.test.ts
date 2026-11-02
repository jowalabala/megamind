import { describe, expect, it } from "vitest";
import {
  builtinPacks,
  CsvError,
  judgeFor,
  judgeVersion,
  packToYaml,
  parseCsv,
  parsePack,
  parseTenantPack,
  readOutcomeCsv,
  unitProblem,
} from "../src/index.ts";

const generic = () => builtinPacks().find((p) => p.id === "generic")!;

describe("rule sets per category (judges)", () => {
  const base = `
id: p
version: 1
name: P
categories:
  - { id: a, name: A, description: a }
  - { id: b, name: B, description: b }
  - { id: c, name: C, description: c }
fallback: c
metrics:
  - { id: m.x, description: x, unit: ratio, better: higher }
`;
  const set = (v: number, cats?: string) => `
  - version: ${v}
    ${cats ? `categories: [${cats}]` : ""}
    requires: [m.x]
    success_if_all: [{ metric: m.x, op: gte, value: 0.5 }]`;

  it("picks the rule set naming the category, else the catch-all", () => {
    const p = parsePack(`${base}judges:${set(3, "a")}${set(3)}`);
    expect(judgeVersion(p)).toBe(3);
    expect(judgeFor(p, "a")?.categories).toEqual(["a"]);
    expect(judgeFor(p, "b")?.categories).toBeUndefined();
    expect(judgeFor(p, null)?.categories).toBeUndefined();
  });

  it("refuses overlapping, unknown or mixed-version rule sets", () => {
    expect(() => parsePack(`${base}judges:${set(1, "a")}${set(1, "a, b")}`)).toThrow(
      /category a is in two rule sets/,
    );
    expect(() => parsePack(`${base}judges:${set(1, "zz")}`)).toThrow(/zz is not a category/);
    expect(() => parsePack(`${base}judges:${set(1, "a")}${set(2, "b")}`)).toThrow(/same version/);
    expect(() => parsePack(`${base}judges:${set(1)}${set(1)}`)).toThrow(/only one rule set/);
  });

  it("the revenue pack judges sequences, emails and deals separately, and nothing else", () => {
    const revenue = builtinPacks().find((p) => p.id === "revenue")!;
    expect(judgeFor(revenue, "prospecting_sequence")?.requires).toEqual(["sequence.reply_rate"]);
    expect(judgeFor(revenue, "campaign_email")?.requires).toContain("email.click_rate");
    expect(judgeFor(revenue, "expansion_deal")?.requires).toEqual(["deal.won"]);
    expect(judgeFor(revenue, "other")).toBeNull();
  });
});

describe("parseTenantPack", () => {
  it("sets the pack and ruleset version from the stored version", () => {
    const p = generic();
    p.metrics = [{ id: "close.days_late", description: "d", unit: "count", better: "lower" }];
    p.judge = {
      version: 99,
      requires: ["close.days_late"],
      skip_categories: [],
      failure_if_any: [],
      success_if_all: [{ metric: "close.days_late", op: "lte", value: 0 }],
      baseline: { days: 180, min_samples: 20 },
    };
    const { pack, yaml } = parseTenantPack(packToYaml(p), 4);
    expect(pack.version).toBe(4);
    expect(pack.judge?.version).toBe(4);
    expect(parseTenantPack(yaml, 4).pack).toEqual(pack);
  });

  it("can't edit built-in connector packs or claim their work", () => {
    const eng = builtinPacks().find((p) => p.id === "engineering")!;
    expect(() => parseTenantPack(packToYaml(eng), 1)).toThrow(/only these packs can be edited/);
    const p = generic();
    p.applies_to = { sources: ["hubspot"], ref_systems: ["github"], code_sessions: true };
    const err = (() => {
      try {
        parseTenantPack(packToYaml(p), 1);
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(err).toMatch(/hubspot has its own pack/);
    expect(err).toMatch(/github has its own pack/);
    expect(err).toMatch(/code sessions/);
  });

  it("rules must use the pack's own metrics", () => {
    const p = generic();
    p.judge = {
      version: 1,
      requires: ["nope"],
      skip_categories: [],
      failure_if_any: [],
      success_if_all: [{ metric: "nope", op: "eq", value: 1 }],
      baseline: { days: 180, min_samples: 20 },
    };
    expect(() => parseTenantPack(packToYaml(p), 1)).toThrow(
      /nope is not one of the pack's metrics/,
    );
  });
});

describe("CSV", () => {
  it("parses quotes, doubled quotes, commas and newlines in quotes, CRLF and a BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\r\n\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"\nthere'],
    ]);
    expect(() => parseCsv('a\n"open')).toThrow(CsvError);
  });

  it("checks the header and each row's shape", () => {
    expect(() => readOutcomeCsv("ref,metric\n")).toThrow(/Missing column\(s\): value/);
    expect(() => readOutcomeCsv("ref,metric,value,secret\n")).toThrow(/Unknown column/);
    const { rows, problems, total } = readOutcomeCsv(
      [
        "ref,metric,value,n,observed_at,owner_email",
        "jira:issue:FIN-1,close.days_late,2,,2026-04-03,",
        "jira:FIN-2,close.days_late,1,,,",
        "jira:issue:FIN-3,close.days_late,yes,,,",
        "jira:issue:FIN-4,close.days_late,1,0,,",
        "jira:issue:FIN-5,close.days_late,1,,not-a-date,",
        "jira:issue:FIN-6,close.days_late,1,,,not-an-email",
      ].join("\n"),
    );
    expect(total).toBe(6);
    expect(rows.map((r) => [r.ref, r.value])).toEqual([
      ["jira:issue:FIN-1", 2],
      ["jira:issue:FIN-3", 1],
    ]);
    expect(problems.map((p) => p.line)).toEqual([3, 5, 6, 7]);
  });

  it("checks values against the metric's unit", () => {
    expect(unitProblem("boolean", 2)).toMatch(/yes\/no/);
    expect(unitProblem("ratio", 1.5)).toMatch(/between 0 and 1/);
    expect(unitProblem("count", -1)).toMatch(/negative/);
    expect(unitProblem("hours", 3.5)).toBeNull();
  });
});
