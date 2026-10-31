// Team skills as Claude Code skills: the approved skills in the categories you subscribed to
// are written to ~/.claude/skills/mm-*/SKILL.md, and removed when they're retired or you
// unsubscribe. Only folders this bridge created (they hold a .mastermind marker) are touched.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api } from "./api.ts";

export interface SubscribedSkill {
  id: string;
  version: number;
  title: string;
  category: string;
  when_to_use: string;
  slug: string;
  markdown: string;
}

const MARKER = ".mastermind";
const SLUG = /^mm-[a-z0-9-]{1,80}$/;

export const skillsDir = () =>
  process.env.MM_CLAUDE_SKILLS_DIR ?? join(homedir(), ".claude", "skills");

export async function fetchSubscribed(api: Api, timeoutMs = 3_000): Promise<SubscribedSkill[]> {
  const res = await api.get<{ skills: SubscribedSkill[] }>("/v1/skills/subscribed", timeoutMs);
  return res.skills.filter((s) => SLUG.test(s.slug));
}

/** Makes the skills folder match `skills`. Returns what changed. */
export function writeSkills(
  skills: SubscribedSkill[],
  dir = skillsDir(),
): { written: string[]; removed: string[] } {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const removed: string[] = [];
  const keep = new Set(skills.map((s) => s.slug));
  for (const s of skills) {
    const folder = join(dir, s.slug);
    const marker = join(folder, MARKER);
    // Never overwrite a folder someone else made with the same name.
    if (existsSync(folder) && !existsSync(marker)) continue;
    const stamp = `${s.id} ${s.version}\n`;
    if (existsSync(marker) && readFileSync(marker, "utf8") === stamp) continue;
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SKILL.md"), s.markdown, { mode: 0o644 });
    writeFileSync(marker, stamp);
    written.push(s.slug);
  }
  for (const name of readdirSync(dir)) {
    if (!SLUG.test(name) || keep.has(name)) continue;
    if (!existsSync(join(dir, name, MARKER))) continue;
    rmSync(join(dir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return { written, removed };
}

export async function syncSkills(api: Api, dir = skillsDir()) {
  const skills = await fetchSubscribed(api);
  return { skills, ...writeSkills(skills, dir) };
}

/** A short note for the agent's context at session start. */
export function skillsContext(skills: SubscribedSkill[]): string | null {
  if (skills.length === 0) return null;
  return [
    `Your team has ${skills.length} approved skill(s) for your kind of work (installed as Claude Code skills):`,
    ...skills
      .slice(0, 15)
      .map((s) => `- ${s.title} (${s.category}): ${s.when_to_use.slice(0, 200)}`),
    "Follow them where they fit, and list the ones you followed in log_task's skills_used.",
  ].join("\n");
}
