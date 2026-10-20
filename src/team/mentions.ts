import type { TeamMember } from "./types.js";

/**
 * Handles are matched only when they stand on their own: `@dev` is a mention,
 * `me@dev.example` is an email, and `@dev/ops` is the handle `dev` followed by
 * punctuation. Unicode letters are allowed so a roster can use Chinese handles
 * (`@研发`) without a separate syntax.
 */
const HANDLE = /(^|[^\p{L}\p{N}_])@([\p{L}\p{N}_-]{1,32})/gu;

/** The human in the room. Mentioning them asks for a decision, not a turn. */
const HUMAN_HANDLES = new Set(["user", "you", "human"]);

/** Every distinct handle in a message, lowercased, in order of appearance. */
export function extractHandles(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // A fresh regex per call: a shared /g/ object would carry `lastIndex` across
  // calls and silently skip the first mention of the next message.
  const re = new RegExp(HANDLE.source, "gu");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const handle = m[2]!.toLowerCase();
    if (!seen.has(handle)) {
      seen.add(handle);
      out.push(handle);
    }
  }
  return out;
}

/**
 * Resolve mentions against a pool of members, in the order they were written.
 * A handle matches the member's `mention` or its `id`, case-insensitively.
 * Handles outside the pool are returned in `unknown` so the caller can explain
 * why nothing happened instead of dropping the request silently.
 */
export function resolveMentions(
  text: string,
  pool: TeamMember[],
): { members: TeamMember[]; unknown: string[]; human: boolean } {
  const byHandle = new Map<string, TeamMember>();
  for (const m of pool) {
    byHandle.set(m.mention.toLowerCase(), m);
    byHandle.set(m.id.toLowerCase(), m);
  }
  const members: TeamMember[] = [];
  const unknown: string[] = [];
  let human = false;
  for (const handle of extractHandles(text)) {
    if (HUMAN_HANDLES.has(handle)) {
      human = true;
      continue;
    }
    const hit = byHandle.get(handle);
    if (!hit) {
      unknown.push(handle);
      continue;
    }
    if (!members.some((m) => m.id === hit.id)) members.push(hit);
  }
  return { members, unknown, human };
}

/** True when the text addresses the human rather than a teammate. */
export function mentionsHuman(text: string): boolean {
  return extractHandles(text).some((h) => HUMAN_HANDLES.has(h));
}
