import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Master skill loader.
 *
 * The canonical source of truth for the master delegation playbook is the pair of
 * markdown files under `skills/agentmesh-master/` at the package root. The MCP
 * server serves them to any connected master as both a *resource* (browsable) and
 * a *tool* result (universally callable), so agentmesh hosts the skill itself —
 * no copy-paste into each agent's config.
 *
 * Resolution walks up from this module to the agentmesh package root, which works
 * both from `src/` (tsx, dev/tests) and from `dist/` (the built, installed binary)
 * since `skills/` ships alongside `dist/` in the published package.
 */

export type SkillLang = "en" | "zh";

const SKILL_DIR = path.join("skills", "agentmesh-master");
const FILE_FOR_LANG: Record<SkillLang, string> = {
  en: "SKILL.md",
  zh: "SKILL.zh.md",
};

export const SKILL_LANGS: readonly SkillLang[] = ["en", "zh"] as const;

let cachedRoot: string | undefined;

/**
 * Find the agentmesh package root by walking up from this module until a
 * `package.json` whose `name` is `agentmesh` is found. Bounded so a stray
 * install can't loop to the filesystem root. Returns undefined if not found.
 */
export function findPackageRoot(): string | undefined {
  if (cachedRoot) return cachedRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string };
        if (parsed?.name === "agentmesh") {
          cachedRoot = dir;
          return dir;
        }
      } catch {
        /* not JSON / unreadable — keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return undefined;
}

/** Absolute path to a language's skill file, or undefined if the root is unknown. */
export function skillPath(lang: SkillLang): string | undefined {
  const root = findPackageRoot();
  if (!root) return undefined;
  return path.join(root, SKILL_DIR, FILE_FOR_LANG[lang]);
}

export type SkillLoadResult =
  | { ok: true; lang: SkillLang; path: string; markdown: string }
  | { ok: false; lang: SkillLang; error: string };

/** Read a language's playbook from disk. Never throws — degrades to `{ ok: false }`. */
export async function readSkill(lang: SkillLang): Promise<SkillLoadResult> {
  const p = skillPath(lang);
  if (!p) {
    return {
      ok: false,
      lang,
      error:
        "agentmesh package root not found; cannot locate skills/agentmesh-master — " +
        "is the server running from an intact install?",
    };
  }
  try {
    const markdown = await readFile(p, "utf8");
    return { ok: true, lang, path: p, markdown };
  } catch (e) {
    return {
      ok: false,
      lang,
      error: `master skill file not readable at ${p}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** The MCP resource URI for a language's playbook. */
export function skillResourceUri(lang: SkillLang): string {
  return `agentmesh://skills/master/${lang}`;
}
