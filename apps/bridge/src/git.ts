// What the agent touched, as stable resource keys: git:<repo>:<path>#L<a>-<b>.
// Repo ids come from the origin remote with any credentials stripped; paths are relative to
// the repository root. Files outside the project are never named.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

export interface RepoInfo {
  /** e.g. github.com/acme/api */
  repo: string;
  root: string;
  branch: string | null;
}

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 2_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Normalizes a remote URL to host/owner/name, dropping user names, tokens and ports. */
export function normalizeRemote(url: string): string | null {
  const u = url.trim();
  // scp-like: git@github.com:acme/api.git
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+?)(?:\.git)?\/?$/.exec(u);
  if (scp && !/^[a-z]+:\/\//i.test(u)) return `${scp[1]}/${scp[2]}`.toLowerCase();
  try {
    const parsed = new URL(u);
    if (!parsed.hostname) return null;
    const path = parsed.pathname
      .replace(/^\/+/, "")
      .replace(/\.git\/?$/, "")
      .replace(/\/+$/, "");
    return path ? `${parsed.hostname}/${path}`.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function repoInfo(cwd: string): RepoInfo | null {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return null;
  const remote = git(root, ["remote", "get-url", "origin"]);
  const repo = (remote && normalizeRemote(remote)) ?? `local/${basename(root)}`;
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return { repo, root, branch: branch && branch !== "HEAD" ? branch : null };
}

/** Path relative to the repo (or cwd), or null when the file is outside both. */
export function projectPath(file: string, cwd: string, info: RepoInfo | null): string | null {
  const abs = isAbsolute(file) ? file : resolve(cwd, file);
  for (const base of [info?.root, cwd]) {
    if (!base) continue;
    const rel = relative(base, abs);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split("\\").join("/");
  }
  return null;
}

/** Changed line ranges (new side) of one file against HEAD; whole file if untracked. */
export function changedRanges(root: string, rel: string): [number, number][] {
  const diff = git(root, ["diff", "--no-color", "--no-ext-diff", "-U0", "HEAD", "--", rel]);
  if (diff === null || diff === "") {
    const tracked = git(root, ["ls-files", "--error-unmatch", "--", rel]);
    if (tracked !== null) return [];
    try {
      const lines = readFileSync(resolve(root, rel), "utf8").split("\n").length;
      return [[1, Math.max(1, lines - 1)]];
    } catch {
      return [];
    }
  }
  const ranges: [number, number][] = [];
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    ranges.push([Math.max(start, 1), Math.max(start, 1) + Math.max(count, 1) - 1]);
  }
  return ranges;
}

/** At most `max` ranges; beyond that, one span covering them all. */
export function compactRanges(ranges: [number, number][], max = 10): [number, number][] {
  if (ranges.length <= max) return ranges;
  return [[Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))]];
}

export function resourceKey(repo: string, rel: string, range?: [number, number]): string {
  return `git:${repo}:${rel}${range ? `#L${range[0]}-${range[1]}` : ""}`;
}
