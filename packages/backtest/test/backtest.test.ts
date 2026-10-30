import { localLake } from "@mm/lake";
import { describe, expect, it } from "vitest";
import { buildReport, parseLabelsCsv, renderMarkdown, wilson } from "../src/index.ts";

const TENANT = "0f8b6a52-3c1d-4e2f-9a7b-1c2d3e4f5a6b";

describe("wilson", () => {
  it("matches known values and stays inside [0, 1]", () => {
    expect(wilson(8, 10)).toEqual({ k: 8, n: 10, rate: 0.8, low: 0.49, high: 0.943 });
    expect(wilson(0, 5)).toMatchObject({ rate: 0, low: 0 });
    expect(wilson(5, 5).high).toBe(1);
    expect(wilson(0, 0)).toEqual({ k: 0, n: 0, rate: null, low: null, high: null });
  });
});

describe("parseLabelsCsv", () => {
  it("reads any subset of label columns; blank means unlabelled", () => {
    const labels = parseLabelsCsv(
      "# hand labels\nrepo,number,reverted,verdict\nAcme/API,12,yes,Failure\nacme/api,13,,success\n",
    );
    expect(labels).toEqual([
      { repo: "acme/api", number: 12, reverted: true, verdict: "failure" },
      { repo: "acme/api", number: 13, verdict: "success" },
    ]);
    expect(() => parseLabelsCsv("number\n1")).toThrow(/repo and number/);
    expect(() => parseLabelsCsv("repo,number\na/b,x")).toThrow(/bad PR number/);
  });
});

describe("buildReport", () => {
  it("splits by when outcomes became known and contrasts features of success and failure", async () => {
    const lake = localLake();
    const day = (d: number) => new Date(Date.UTC(2026, 0, 1) + d * 86_400_000).toISOString();
    const records = [];
    for (let i = 0; i < 24; i++) {
      const success = i % 3 !== 0;
      const id = `task-${i}`;
      records.push(
        {
          id: i * 2,
          table: "tasks" as const,
          eventId: id,
          row: {
            event_id: id,
            event_time: day(i),
            // Successful work here has tests; failures don't.
            features: JSON.stringify({
              tests_touched: success,
              size_lines: success ? 80 : 400 + i,
            }),
          },
        },
        {
          id: i * 2 + 1,
          table: "judgments" as const,
          eventId: `j-${i}`,
          row: {
            event_id: `j-${i}`,
            task_id: id,
            ruleset_version: 1,
            category: i % 2 ? "feature" : "bugfix",
            verdict: success ? "success" : "failure",
            event_time: day(i),
          },
        },
      );
    }
    await lake.put(TENANT, records);
    const r = await buildReport(lake, TENANT, { trainEnd: new Date(day(18)) });
    expect(r.judged).toBe(24);
    expect(r.categories.feature!.train.judged + r.categories.bugfix!.train.judged).toBe(18);
    expect(r.categories.feature!.test.judged + r.categories.bugfix!.test.judged).toBe(6);
    expect(r.contrasts.map((c) => c.feature).sort()).toEqual(["size_lines", "tests_touched"]);
    const tests = r.contrasts.find((c) => c.feature === "tests_touched")!;
    expect(tests).toMatchObject({ successMean: 1, failureMean: 0 });
    expect(renderMarkdown(r)).toContain("| tests_touched | 1 | 0 |");
  });
});
