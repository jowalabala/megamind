import { describe, expect, it } from "vitest";
import {
  authorizeUrl,
  listSequences,
  OUTCOME_PROPERTIES,
  sequenceCounts,
  type HubspotClient,
} from "../src/index.ts";

const day = (d: number) => new Date(Date.UTC(2026, 0, d)).toISOString();

function fakeClient(pages: Record<string, unknown>[][]): HubspotClient & { bodies: unknown[] } {
  const bodies: unknown[] = [];
  let i = 0;
  return {
    bodies,
    get: async () => ({}) as never,
    post: async (_path, body) => {
      bodies.push(body);
      const results = pages[i++] ?? [];
      return {
        results,
        ...(i < pages.length ? { paging: { next: { after: String(i) } } } : {}),
      } as never;
    },
  };
}

describe("sequenceCounts", () => {
  it("counts replies and meetings after enrolment, across pages, asking for dates only", async () => {
    const c = fakeClient([
      [
        {
          properties: {
            hs_latest_sequence_enrolled_date: day(1),
            hs_sales_email_last_replied: day(3),
          },
        },
        // Replied before this enrolment: doesn't count.
        {
          properties: {
            hs_latest_sequence_enrolled_date: day(5),
            hs_sales_email_last_replied: day(2),
          },
        },
      ],
      [
        {
          properties: {
            hs_latest_sequence_enrolled_date: day(1),
            hs_sales_email_last_replied: day(4),
            engagements_last_meeting_booked: day(6),
          },
        },
        { properties: {} }, // no enrolment date: not counted at all
      ],
    ]);
    expect(await sequenceCounts(c, "42", new Date(day(20)))).toEqual({
      enrolled: 3,
      replied: 2,
      meetings: 1,
    });
    const first = c.bodies[0] as {
      properties: string[];
      filterGroups: { filters: { value: string }[] }[];
    };
    expect(first.properties).toEqual([...OUTCOME_PROPERTIES]);
    expect(first.filterGroups[0]!.filters[0]!.value).toBe("42");
    expect((c.bodies[1] as { after: string }).after).toBe("1");
  });
});

describe("listSequences", () => {
  it("reads each sequence's steps", async () => {
    const c: HubspotClient = {
      post: async () => ({}) as never,
      get: async (path) =>
        (path.endsWith("/sequences")
          ? { results: [{ id: 7 }] }
          : {
              id: 7,
              name: "Outbound",
              createdAt: day(1),
              steps: [
                { actionType: "SEND_EMAIL" },
                { actionType: "CREATE_TASK" },
                { actionType: "SEND_EMAIL" },
              ],
            }) as never,
    };
    expect(await listSequences(c, 501)).toEqual([
      expect.objectContaining({ id: "7", userId: 501, steps: 3, emailSteps: 2, taskSteps: 1 }),
    ]);
  });
});

it("asks HubSpot for read-only scopes", () => {
  const u = new URL(
    authorizeUrl({ clientId: "id", clientSecret: "s", redirectUri: "https://mm.test/cb" }, "st"),
  );
  const scopes = u.searchParams.get("scope")!.split(" ");
  expect(scopes.every((s) => s === "oauth" || s.endsWith(".read"))).toBe(true);
  expect(u.searchParams.get("state")).toBe("st");
});
