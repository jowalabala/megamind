import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_MIN_CONFIDENCE,
  heuristicConfidence,
  jaccard,
  titleWords,
} from "../src/index.ts";

describe("heuristic attribution", () => {
  const sim = (a: string, b: string) => jaccard(titleWords(a), titleWords(b));

  it("is confident only when the time is close and the titles agree", () => {
    const close = heuristicConfidence(
      2,
      sim("Draft outbound sequence for CFOs", "Outbound CFOs Q3"),
    );
    expect(close).toBeGreaterThanOrEqual(ATTRIBUTION_MIN_CONFIDENCE);
    // Same timing, unrelated titles: kept below the bar.
    expect(heuristicConfidence(2, sim("Fix login bug", "Outbound CFOs Q3"))).toBeLessThan(
      ATTRIBUTION_MIN_CONFIDENCE,
    );
    // Same titles, three days later: weaker.
    expect(heuristicConfidence(70, 0.4)).toBeLessThan(close);
  });

  it("is zero outside the window", () => {
    expect(heuristicConfidence(-25, 1)).toBe(0);
    expect(heuristicConfidence(73, 1)).toBe(0);
    expect(heuristicConfidence(0, 1)).toBe(1);
  });

  it("ignores filler words", () => {
    expect([...titleWords("Add a new sequence for the CFOs")]).toEqual(["sequence", "cfos"]);
  });
});
