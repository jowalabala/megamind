// Resource keys: the shared vocabulary for "what is this agent touching".
//   git:<host/owner/repo>:<path>[#L<a>-<b>]   a file, optionally with changed line ranges
//   <system>:<type>:<id>                       e.g. hubspot:list:123
//   tag:<pack>:<name>                          a generic topic
// Normalized so the same file always has the same key: lowercase repo, "./" and "//" removed.

export interface ParsedResource {
  /** The key without line ranges: what two sessions must share to overlap at all. */
  base: string;
  repo: string | null;
  lines: [number, number][];
}

const GIT = /^git:([^:]+):(.+?)(?:#L(\d+)-(\d+))?$/;

export function parseResource(raw: string): ParsedResource | null {
  const s = raw.trim();
  if (!s || s.length > 600) return null;
  const g = GIT.exec(s);
  if (g) {
    const repo = g[1]!.toLowerCase().replace(/\.git$/, "");
    const path = g[2]!
      .replace(/^\.\//, "")
      .replace(/\/{2,}/g, "/")
      .replace(/\/$/, "");
    if (!path || path.includes("..")) return null;
    const lines: [number, number][] = [];
    if (g[3] && g[4]) {
      const a = Number(g[3]);
      const b = Number(g[4]);
      if (a > 0 && b >= a) lines.push([a, b]);
    }
    return { base: `git:${repo}:${path}`, repo, lines };
  }
  if (/^[a-z][a-z0-9_]{0,30}:[a-z0-9_]{1,30}:\S+$/i.test(s)) {
    return { base: s.toLowerCase(), repo: null, lines: [] };
  }
  return null;
}

/** Normalizes a key (and merges line ranges); null if it isn't a resource key. */
export function normalizeResource(raw: string): string | null {
  const p = parseResource(raw);
  if (!p) return null;
  return p.lines.length ? `${p.base}#L${p.lines[0]![0]}-${p.lines[0]![1]}` : p.base;
}

/** Everything one session touches, grouped by base key, with merged line ranges. */
export function groupResources(
  raws: string[],
): Map<string, { repo: string | null; lines: [number, number][]; whole: boolean }> {
  const out = new Map<string, { repo: string | null; lines: [number, number][]; whole: boolean }>();
  for (const raw of raws) {
    const p = parseResource(raw);
    if (!p) continue;
    const cur = out.get(p.base) ?? { repo: p.repo, lines: [], whole: false };
    if (p.lines.length) cur.lines.push(...p.lines);
    else cur.whole = true;
    out.set(p.base, cur);
  }
  for (const v of out.values()) v.lines = mergeRanges(v.lines);
  return out;
}

export function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

export function rangesIntersect(a: [number, number][], b: [number, number][]): [number, number][] {
  const hits: [number, number][] = [];
  for (const x of a)
    for (const y of b) {
      const lo = Math.max(x[0], y[0]);
      const hi = Math.min(x[1], y[1]);
      if (lo <= hi) hits.push([lo, hi]);
    }
  return mergeRanges(hits);
}

const STOP = new Set(
  "a an and the of to in on for with by from at is are be this that it as or into via add fix update use make new work".split(
    " ",
  ),
);

export function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/\[(person|email|secret)[^\]]*\]/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** Jaccard similarity of meaningful words. A cheap stand-in until intent embeddings exist. */
export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}
