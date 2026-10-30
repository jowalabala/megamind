// A labelled repository history for the week 5 check.
//
// acme/billing: ~60 PRs over ten months, each with ground-truth labels (was it reverted,
// did it cause a bug fixed within 60 days, did CI pass first time). The generator keeps
// line-level authorship for every file at every commit, so the fake GitHub can answer blame
// and serve real diffs, exactly as SZZ-lite will query them.
//
// A few cases are built so the signals get them wrong, as they would in a real repository:
// a fix that only adds a missing check (nothing to blame), a fix to code a refactor rewrote
// (blame points at the refactor), and a manual undo that doesn't say what it reverts.
import { createHash } from "node:crypto";
import type { GqlPr } from "../src/queries.ts";

export const BILLING_REPO = { id: 2001, full_name: "acme/billing" };
const FILES = [
  "src/invoice.ts",
  "src/tax.ts",
  "src/refund.ts",
  "src/ledger.ts",
  "src/api.ts",
  "src/ui.tsx",
];
const INITIAL_PR = 1;

type ChangeSpec =
  | { file: string; start: number; count: number } // replace a range
  | { ownedBy: number; count: number } // replace lines currently owned by a PR
  | { addNextTo: number }; // add two lines next to a PR's code (deletes nothing)

interface PrSpec {
  number: number;
  title: string;
  /** Days before "now" it merged. */
  day: number;
  ci?: "SUCCESS" | "FAILURE";
  rounds?: number;
  body?: string;
  author?: { __typename: string; login: string; databaseId: number };
  changes?: ChangeSpec[];
  /** Ground truth: this PR is a fix for the bug these PRs introduced. */
  fixes?: number[];
  /** Ground truth: this PR reverts these PRs. */
  reverts?: number[];
  /** Body says "This reverts commit <merge sha of N>". */
  revertsCommitOf?: number;
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex");
export const mergeSha = (n: number) => sha(`merge-${n}`);

function specs(): PrSpec[] {
  const s: PrSpec[] = [
    {
      number: 10,
      title: "feat: invoice line grouping",
      day: 300,
      changes: [{ file: "src/invoice.ts", start: 10, count: 10 }],
    },
    {
      number: 11,
      title: "feat: tax regions",
      day: 295,
      changes: [{ file: "src/tax.ts", start: 5, count: 10 }],
    },
    {
      number: 12,
      title: "feat: partial refunds",
      day: 290,
      rounds: 1,
      changes: [{ file: "src/refund.ts", start: 20, count: 10 }],
    },
    {
      number: 13,
      title: "fix: refund rounding",
      day: 285,
      changes: [{ ownedBy: 12, count: 2 }],
      fixes: [12],
    },
    {
      number: 14,
      title: "feat: ledger export",
      day: 280,
      ci: "FAILURE",
      changes: [{ file: "src/ledger.ts", start: 30, count: 10 }],
    },
    {
      number: 15,
      title: "refactor: split api handlers",
      day: 275,
      changes: [{ file: "src/api.ts", start: 1, count: 20 }],
    },
    {
      number: 16,
      title: "feat: invoice table",
      day: 270,
      changes: [{ file: "src/ui.tsx", start: 40, count: 10 }],
    },
    {
      number: 17,
      title: 'Revert "feat: invoice table"',
      day: 268,
      body: "Reverts acme/billing#16",
      reverts: [16],
      changes: [{ ownedBy: 16, count: 10 }],
    },
    {
      number: 18,
      title: "feat: invoice table, take two",
      day: 265,
      rounds: 2,
      changes: [{ file: "src/ui.tsx", start: 40, count: 10 }],
    },
    {
      number: 19,
      title: "feat: tax exemptions",
      day: 260,
      changes: [{ file: "src/tax.ts", start: 30, count: 10 }],
    },
    // 65 days later: outside the defect window, so not counted against #19.
    { number: 20, title: "fix: exemption check", day: 195, changes: [{ ownedBy: 19, count: 2 }] },
    {
      number: 21,
      title: "feat: ledger reconciliation",
      day: 255,
      changes: [{ file: "src/ledger.ts", start: 50, count: 10 }],
    },
    {
      number: 22,
      title: "fix: reconciliation off by one",
      day: 240,
      changes: [{ ownedBy: 21, count: 1 }],
      fixes: [21],
    },
    {
      number: 23,
      title: "chore: tidy imports",
      day: 235,
      changes: [{ file: "src/api.ts", start: 70, count: 5 }],
    },
    {
      number: 24,
      title: "feat: refunds to wallet",
      day: 230,
      ci: "FAILURE",
      rounds: 3,
      changes: [{ file: "src/refund.ts", start: 60, count: 10 }],
    },
    // Adds a missing guard and deletes nothing: SZZ has nothing to blame. (Miss.)
    {
      number: 25,
      title: "fix: wallet refund missing guard",
      day: 220,
      changes: [{ addNextTo: 24 }],
      fixes: [24],
    },
    {
      number: 26,
      title: "feat: invoice pdf",
      day: 215,
      changes: [{ file: "src/invoice.ts", start: 60, count: 10 }],
    },
    {
      number: 27,
      title: "refactor: invoice pdf renderer",
      day: 212,
      changes: [{ ownedBy: 26, count: 10 }],
    },
    // The bug came from #26, but #27 rewrote those lines: blame points at #27. (Miss + false alarm.)
    {
      number: 28,
      title: "fix: pdf totals",
      day: 200,
      changes: [{ ownedBy: 27, count: 2 }],
      fixes: [26],
    },
    {
      number: 30,
      title: "feat: ledger rounding",
      day: 190,
      changes: [{ file: "src/ledger.ts", start: 70, count: 8 }],
    },
    // A manual undo that names nothing. (Miss.)
    {
      number: 31,
      title: "Undo ledger rounding change",
      day: 185,
      body: "Rolling back, it broke month-end.",
      reverts: [30],
      changes: [{ ownedBy: 30, count: 8 }],
    },
    {
      number: 32,
      title: "docs: billing guide",
      day: 180,
      changes: [{ file: "docs/billing.md", start: 1, count: 5 }],
    },
    {
      number: 33,
      title: "Bump zod from 3.25.0 to 4.1.0",
      day: 178,
      author: { __typename: "Bot", login: "dependabot", databaseId: 49699333 },
      changes: [{ file: "package.json", start: 3, count: 1 }],
    },
  ];

  // Ordinary work, with fixes and reverts mixed in.
  const kinds = ["feat", "perf", "refactor", "feat", "feat"];
  for (let i = 0; i < 40; i++) {
    const n = 40 + i;
    const day = 170 - Math.floor(i * 2.6);
    const base: PrSpec = {
      number: n,
      title: `${kinds[i % kinds.length]}: billing improvement ${n}`,
      day,
      ci: i % 4 === 3 ? "FAILURE" : "SUCCESS",
      rounds: i % 9 === 0 ? 3 : i % 3,
      changes: [{ file: FILES[i % FILES.length]!, start: 80 + Math.floor(i / 6) * 5, count: 4 }],
    };
    if (i % 7 === 6) {
      // A fix for a PR merged about a week earlier.
      Object.assign(base, {
        title: `fix: regression from #${n - 3}`,
        changes: [{ ownedBy: n - 3, count: 2 }],
        fixes: [n - 3],
      });
    } else if (i % 11 === 10) {
      Object.assign(base, {
        title: `Revert billing improvement ${n - 2}`,
        body: `This reverts commit ${mergeSha(n - 2)}.`,
        changes: [{ ownedBy: n - 2, count: 4 }],
        reverts: [n - 2],
        revertsCommitOf: n - 2,
      });
    }
    s.push(base);
  }
  // Recent work: not mature yet, so not judged.
  for (const [n, day] of [
    [90, 40],
    [91, 30],
    [92, 20],
  ] as const) {
    s.push({
      number: n,
      title: `feat: recent work ${n}`,
      day,
      changes: [{ file: "src/api.ts", start: 112, count: 2 }],
    });
  }
  return s;
}

export interface TruthLabel {
  number: number;
  reverted: boolean;
  escapedDefect: boolean;
  ciFirstPass: boolean;
}

/** Builds the history: fixture PRs, per-commit blame, per-PR diffs, and the truth. */
export function buildHistory(now = Date.now()) {
  const all = specs().sort((a, b) => b.day - a.day); // oldest first
  const at = (day: number, hours = 0) =>
    new Date(now - day * 86_400_000 + hours * 3_600_000).toISOString();

  // Line ownership per file, as PR numbers. Everything starts as the initial import.
  const owners: Record<string, number[]> = {};
  const ensure = (f: string) => (owners[f] ??= Array.from({ length: 120 }, () => INITIAL_PR));
  const snapshots = new Map<string, Record<string, number[]>>();
  const mergedAt = new Map<number, string>([[INITIAL_PR, at(400)]]);
  const patches = new Map<number, { filename: string; status: string; patch: string }[]>();
  const baseShas = new Map<number, string>();
  let tip = mergeSha(INITIAL_PR);
  snapshots.set(tip, structuredClone(owners));

  for (const spec of all) {
    baseShas.set(spec.number, tip);
    const files: { filename: string; status: string; patch: string }[] = [];
    for (const c of spec.changes ?? []) {
      if ("file" in c) {
        const lines = ensure(c.file);
        const hunk = [`@@ -${c.start},${c.count} +${c.start},${c.count} @@`];
        for (let i = 0; i < c.count; i++) hunk.push(`-  total += line${c.start + i}(rate, qty);`);
        for (let i = 0; i < c.count; i++)
          hunk.push(`+  total += line${c.start + i}v${spec.number}(rate, qty);`);
        for (let i = 0; i < c.count; i++) lines[c.start - 1 + i] = spec.number;
        files.push({ filename: c.file, status: "modified", patch: hunk.join("\n") });
      } else if ("ownedBy" in c) {
        const [file, lines] = Object.entries(owners).find(([, l]) => l.includes(c.ownedBy)) ?? [];
        if (!file || !lines) throw new Error(`PR ${spec.number}: no lines owned by #${c.ownedBy}`);
        const start = lines.indexOf(c.ownedBy) + 1;
        const hunk = [`@@ -${start},${c.count} +${start},${c.count} @@`];
        for (let i = 0; i < c.count; i++) hunk.push(`-  value = compute${start + i}(input);`);
        for (let i = 0; i < c.count; i++) hunk.push(`+  value = compute${start + i}Fixed(input);`);
        for (let i = 0; i < c.count; i++) lines[start - 1 + i] = spec.number;
        files.push({ filename: file, status: "modified", patch: hunk.join("\n") });
      } else {
        const [file, lines] = Object.entries(owners).find(([, l]) => l.includes(c.addNextTo))!;
        const after = lines.indexOf(c.addNextTo) + 1;
        files.push({
          filename: file,
          status: "modified",
          patch: [
            `@@ -${after},0 +${after + 1},2 @@`,
            "+  if (!wallet) return;",
            "+  // guard",
          ].join("\n"),
        });
        lines.splice(after, 0, spec.number, spec.number);
      }
    }
    patches.set(spec.number, files);
    mergedAt.set(spec.number, at(spec.day));
    tip = mergeSha(spec.number);
    snapshots.set(tip, structuredClone(owners));
  }

  const prs: GqlPr[] = all.map((spec) => {
    const rounds = spec.rounds ?? 0;
    const opened = at(spec.day, -(6 + rounds * 10));
    const ci = spec.ci ?? "SUCCESS";
    return {
      databaseId: 500_000 + spec.number,
      number: spec.number,
      title: spec.title,
      body: spec.body ?? "",
      state: "MERGED",
      isDraft: false,
      createdAt: opened,
      updatedAt: mergedAt.get(spec.number)!,
      mergedAt: mergedAt.get(spec.number)!,
      closedAt: mergedAt.get(spec.number)!,
      author: spec.author ?? {
        __typename: "User",
        login: `dev${spec.number % 5}`,
        databaseId: 7000 + (spec.number % 5),
      },
      additions: 10,
      deletions: 4,
      changedFiles: patches.get(spec.number)!.length,
      baseRefName: "main",
      baseRefOid: baseShas.get(spec.number)!,
      headRefName: `work-${spec.number}`,
      headRefOid: sha(`head-${spec.number}`),
      mergeCommit: { oid: mergeSha(spec.number) },
      labels: { nodes: [] },
      commits: { totalCount: 2 },
      lastCommit: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
      firstCommit: { nodes: [{ commit: { statusCheckRollup: { state: ci } } }] },
      commitList: {
        nodes: [{ commit: { messageHeadline: spec.title, parents: { totalCount: 1 } } }],
      },
      reviews: {
        nodes: Array.from({ length: rounds }, (_, i) => ({
          state: "CHANGES_REQUESTED",
          submittedAt: at(spec.day, -(5 + i)),
          author: { __typename: "User", login: "reviewer", databaseId: 9999 },
        })),
      },
      files: {
        nodes: patches
          .get(spec.number)!
          .map((f) => ({ path: f.filename, additions: 2, deletions: 2 })),
      },
      closingIssuesReferences: { nodes: [] },
    };
  });

  const truth = new Map<number, TruthLabel>();
  for (const spec of all) {
    truth.set(spec.number, {
      number: spec.number,
      reverted: false,
      escapedDefect: false,
      ciFirstPass: (spec.ci ?? "SUCCESS") === "SUCCESS",
    });
  }
  const days = (a: number, b: number) =>
    (Date.parse(mergedAt.get(b)!) - Date.parse(mergedAt.get(a)!)) / 86_400_000;
  for (const spec of all) {
    for (const x of spec.fixes ?? [])
      if (days(x, spec.number) <= 60) truth.get(x)!.escapedDefect = true;
    for (const x of spec.reverts ?? [])
      if (days(x, spec.number) <= 30) truth.get(x)!.reverted = true;
  }

  return {
    repo: { ...BILLING_REPO, archived: false, prs: [...prs].reverse() }, // newest first, like GitHub
    truth,
    files: (_fullName: string, number: number) => patches.get(number) ?? [],
    blame: (oid: string, path: string) => {
      const snap = snapshots.get(oid);
      const lines = snap?.[path];
      if (!lines) return null;
      const ranges: unknown[] = [];
      let start = 0;
      for (let i = 1; i <= lines.length; i++) {
        if (i === lines.length || lines[i] !== lines[start]) {
          const owner = lines[start]!;
          ranges.push({
            startingLine: start + 1,
            endingLine: i,
            commit: {
              oid: mergeSha(owner),
              associatedPullRequests: {
                nodes: [{ number: owner, mergedAt: mergedAt.get(owner)! }],
              },
            },
          });
          start = i;
        }
      }
      return { blame: { ranges } };
    },
  };
}
