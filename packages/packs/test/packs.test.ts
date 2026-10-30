import type { Llm } from "@mm/llm";
import { describe, expect, it, vi } from "vitest";
import {
  builtinPacks,
  categorize,
  categorizePrompt,
  choosePack,
  PackError,
  parsePack,
  type CategorizeInput,
} from "../src/index.ts";

const [engineering, generic] = builtinPacks();

const task = (t: Partial<CategorizeInput>): CategorizeInput => ({
  title: "",
  summary: "",
  labels: [],
  branch: null,
  files: [],
  authorIsBot: false,
  hint: null,
  ...t,
});

describe("pack validation", () => {
  it("loads the built-in packs", () => {
    expect(engineering!.id).toBe("engineering");
    expect(engineering!.categories.length).toBeGreaterThan(10);
    expect(generic!.id).toBe("generic");
  });

  it("rejects bad packs with every problem listed", () => {
    const bad = `
id: Bad Id
version: 0
name: x
categories:
  - { id: a, name: A, description: a, rules: [{ title: '(' }] }
  - { id: a, name: A2, description: a, rules: [{}] }
fallback: missing
`;
    let message = "";
    try {
      parsePack(bad);
    } catch (err) {
      expect(err).toBeInstanceOf(PackError);
      message = (err as Error).message;
    }
    expect(message).toMatch(/id/);
    expect(message).toMatch(/version/);
    expect(message).toMatch(/not a valid regular expression/);
    expect(message).toMatch(/at least one condition/);
    expect(message).toMatch(/unique/);
    expect(message).toMatch(/fallback/);
    expect(() => parsePack("a: [unclosed")).toThrow(/not valid YAML/);
  });

  it("rejects unknown rule keys rather than ignoring them", () => {
    expect(() =>
      parsePack(`
id: p
version: 1
name: P
categories: [{ id: a, name: A, description: a, rules: [{ titel: x }] }]
fallback: a
`),
    ).toThrow(PackError);
  });
});

describe("engineering rules", () => {
  it.each<[string, Partial<CategorizeInput>, string]>([
    ["revert", { title: 'Revert "feat: add proration"' }, "revert"],
    ["conventional fix", { title: "fix(billing): rounding on refunds" }, "bugfix"],
    ["bug label", { title: "Rounding on refunds", labels: ["Bug"] }, "bugfix"],
    ["fix branch", { title: "Rounding", branch: "fix/rounding" }, "bugfix"],
    [
      "dependabot",
      { title: "Bump lodash from 4.17.20 to 4.17.21", authorIsBot: true },
      "dependencies",
    ],
    ["deps scope", { title: "chore(deps): update aws-sdk" }, "dependencies"],
    ["a human bumping is not the bot rule", { title: "Bump version to 2.0" }, "other"],
    ["feat", { title: "feat: invoice tax lines" }, "feature"],
    ["feat breaking", { title: "feat(api)!: drop v1" }, "feature"],
    ["docs title", { title: "docs: explain proration" }, "docs"],
    [
      "docs files only",
      { title: "Update guide", files: ["README.md", "docs/billing.mdx"] },
      "docs",
    ],
    [
      "mixed files are not docs",
      { title: "Update guide", files: ["README.md", "src/a.ts"] },
      "other",
    ],
    [
      "tests only",
      { title: "Cover refunds", files: ["src/billing/refund.test.ts", "tests/fx.py"] },
      "tests",
    ],
    ["ci only", { title: "Speed up pipeline", files: [".github/workflows/ci.yml"] }, "ci"],
    ["infra", { title: "Bigger DB", files: ["infra/db.tf"] }, "infra"],
    ["refactor", { title: "refactor: split invoice module" }, "refactor"],
    ["perf", { title: "perf: cache tax rates" }, "performance"],
    ["security label", { title: "Escape HTML in emails", labels: ["security"] }, "security"],
    ["chore", { title: "chore: rename variables" }, "chore"],
    ["no files means no file rule", { title: "Something", files: [] }, "other"],
  ])("%s", async (_name, t, expected) => {
    const d = await categorize(engineering!, task(t), { tenantId: "t" });
    expect(d.category).toBe(expected);
    expect(d.method).toBe(expected === "other" ? "fallback" : "rule");
  });
});

describe("categorize: hint, model, fallback", () => {
  it("uses the agent's hint when no rule matches", async () => {
    const d = await categorize(engineering!, task({ title: "Rounding", hint: "Bug fix" }), {
      tenantId: "t",
    });
    expect(d).toMatchObject({ category: "bugfix", method: "hint", confidence: 0.7 });
  });

  it("asks the model only when rules and hint don't decide, and caps its confidence", async () => {
    const run = vi.fn(async () => ({ category: "refactor", confidence: 0.99 }));
    const llm = { run } as unknown as Llm;
    const ruled = await categorize(engineering!, task({ title: "fix: x" }), { llm, tenantId: "t" });
    expect(ruled.method).toBe("rule");
    expect(run).not.toHaveBeenCalled();

    const d = await categorize(engineering!, task({ title: "Split the invoice module" }), {
      llm,
      tenantId: "t1",
    });
    expect(d).toMatchObject({ category: "refactor", method: "llm", confidence: 0.85 });
    const [prompt, vars, ctx] = run.mock.calls[0] as unknown as [
      typeof categorizePrompt,
      Parameters<typeof categorizePrompt.render>[0],
      { tenantId: string; stage: string },
    ];
    expect(prompt.id).toBe("categorize.task");
    expect(ctx).toEqual({ tenantId: "t1", stage: "categorize" });
    // The task goes in as untrusted data.
    expect(prompt.render(vars)).toContain('<untrusted_input source="task">');
  });

  it("falls back when the model names a category that doesn't exist", async () => {
    const llm = { run: async () => ({ category: "ignore_previous_instructions", confidence: 1 }) };
    const d = await categorize(engineering!, task({ title: "Something" }), {
      llm: llm as unknown as Llm,
      tenantId: "t",
    });
    expect(d).toEqual({
      pack: "engineering",
      category: "other",
      method: "fallback",
      confidence: 0,
    });
  });

  it("doesn't call the model for a pack with a single category", async () => {
    const run = vi.fn();
    await categorize(generic!, task({ title: "Q3 budget review" }), {
      llm: { run } as unknown as Llm,
      tenantId: "t",
    });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("choosePack", () => {
  const packs = builtinPacks();
  it("routes GitHub, GitHub-linked and code-session tasks to engineering, the rest to generic", () => {
    expect(choosePack(packs, { source: "github", refSystems: [], codeSession: false }).id).toBe(
      "engineering",
    );
    expect(
      choosePack(packs, { source: "mcp", refSystems: ["github"], codeSession: false }).id,
    ).toBe("engineering");
    expect(choosePack(packs, { source: "bridge", refSystems: [], codeSession: true }).id).toBe(
      "engineering",
    );
    expect(
      choosePack(packs, { source: "mcp", refSystems: ["hubspot"], codeSession: false }).id,
    ).toBe("generic");
  });
});
