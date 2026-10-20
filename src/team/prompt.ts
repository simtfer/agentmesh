import type { TeamMember, TeamMessage } from "./types.js";

export interface RenderTurnInput {
  teamName: string;
  member: TeamMember;
  channelId: string;
  channelTitle: string;
  channelDescription?: string;
  /** members currently addressable in this room */
  audience: TeamMember[];
  /** messages posted before the trigger, oldest first */
  transcript: TeamMessage[];
  trigger: TeamMessage;
  /** contents of the member's MEMORY.md, already capped by the caller */
  memory: string;
  maxContextChars: number;
}

/** Everything a pulse has in common with a normal turn — minus the message. */
export interface RenderPulseInput extends Omit<RenderTurnInput, "trigger"> {
  /** how often this member wakes up, for its own sense of pacing */
  everyMs: number;
  /** when the room last saw any chat traffic (0 = never) */
  lastActivityAt: number;
}

/** The reply a member uses to say "nothing to add"; it is not posted. */
export const SILENT = "SILENT";

const hhmm = (ts: number) => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

function authorLabel(m: TeamMessage, audience: TeamMember[]): string {
  if (m.author === "user") return "user";
  if (m.author === "system") return "system";
  const member = audience.find((a) => a.id === m.author);
  return member ? `${member.name} (@${member.mention})` : m.authorName;
}

/** Keep the most recent lines, dropping whole messages until the budget fits. */
function recent(lines: string[], maxChars: number): string[] {
  let total = 0;
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (total + line.length > maxChars && kept.length > 0) break;
    kept.unshift(line);
    total += line.length + 1;
  }
  return kept;
}

/** "42 minutes ago", for a member that has to judge whether the room is stale. */
function ago(ms: number): string {
  if (ms < 60_000) return "less than a minute ago";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** The part of a prompt that describes the situation, not the job. */
function situation(
  input: RenderTurnInput | RenderPulseInput,
): { roster: string[]; transcriptText: string; notes: string; memoryText: string } {
  const { member, audience, transcript, memory, maxContextChars } = input;

  const roster = audience.map((m) => {
    const self = m.id === member.id ? " (you)" : "";
    const role = m.role ? ` — ${m.role}` : "";
    return `- @${m.mention} (${m.name})${role}${self}`;
  });

  const lines = transcript.map(
    (m) => `[${hhmm(m.createdAt)}] ${authorLabel(m, audience)}: ${m.text}`,
  );
  const kept = recent(lines, Math.max(500, maxContextChars));
  const transcriptText =
    kept.length > 0
      ? kept.join("\n")
      : lines.length > 0
        ? // A single message bigger than the budget is still the context; clip
          // it rather than pretending the room is empty.
          `${lines[lines.length - 1]!.slice(0, maxContextChars)}\n…(earlier messages omitted)`
        : "(nothing has been said here yet)";

  return {
    roster,
    transcriptText,
    notes: member.notes?.trim() ?? "",
    memoryText: memory.trim(),
  };
}

function header(input: RenderTurnInput | RenderPulseInput): string {
  const { teamName, member, channelId, channelTitle, channelDescription } = input;
  const s = situation(input);
  return `You are ${member.name} (@${member.mention}), a member of the team "${teamName}"${
    member.role ? `, working as: ${member.role}` : ""
  }.

You are in ${channelTitle} (${channelId})${channelDescription ? ` — ${channelDescription}` : ""}.
People in this room:
${s.roster.join("\n")}

Your workspace: ${member.cwd}
Your long-term memory file: ${member.memoryFile}

## Your standing notes
${s.notes.length > 0 ? s.notes : "(none)"}

## Your memory (re-read every turn; append durable facts to the file above)
${s.memoryText.length > 0 ? s.memoryText : "(empty — record decisions, context and preferences here as you learn them)"}

## Recent messages in ${channelTitle}
${s.transcriptText}`;
}

/**
 * The prompt is the member's whole job description for one turn: who it is,
 * who else is in the room, what was just said, and the one convention that
 * makes a team work — a reply is a message, and an `@handle` in it hands the
 * next turn to that teammate.
 *
 * It deliberately does *not* describe the task machinery (tasks, workers,
 * sessions). A member should think in terms of colleagues and a room; the
 * orchestration below the prompt is an implementation detail it cannot act on.
 */
export function renderTurnPrompt(input: RenderTurnInput): string {
  const { member, audience, trigger } = input;
  const triggerWho = trigger.author === "user" ? "the user" : authorLabel(trigger, audience);
  const addressed =
    trigger.mentions.length > 0
      ? ` (addressed to ${trigger.mentions.map((id) => `@${audience.find((m) => m.id === id)?.mention ?? id}`).join(", ")})`
      : "";

  return `${header(input)}

## New message from ${triggerWho}${addressed}
${trigger.text}

## How to reply
Write your reply as ${member.name}. It is posted to ${input.channelTitle} verbatim — teammates and the user see exactly this text, so make it a message, not a status report about a message.

- To hand the next turn to a teammate, mention them by handle: @${audience.find((m) => m.id !== member.id)?.mention ?? "teammate"}. That queues one turn for them and your message becomes their brief, so include what they need to know.
- Mention someone only when they should act next. Do not mention people to keep a thread alive, and never mention yourself.
- If you need a human decision, ask the user with @user and say what you need.
- You share a workspace and a team. Do not claim work another member did, and do not speak for them.
- If the message needs no action from you, say so briefly instead of inventing work.
- Keep it concise: this is a shared room, not a report to a manager.`;
}

/**
 * A pulse is the member waking up with nothing addressed to it. That is the one
 * situation where saying nothing is the right answer, so silence has to be an
 * explicit, cheap option — otherwise every wake-up becomes a "no update" post
 * and the room fills with noise nobody asked for.
 */
export function renderPulsePrompt(input: RenderPulseInput): string {
  const { member, audience, channelTitle, everyMs, lastActivityAt } = input;
  const cadence =
    everyMs >= 60_000
      ? `${Math.round(everyMs / 60_000)} minute${Math.round(everyMs / 60_000) === 1 ? "" : "s"}`
      : `${Math.round(everyMs / 1000)} seconds`;
  const idleFor = lastActivityAt > 0 ? ` The last message here was ${ago(Date.now() - lastActivityAt)}.` : "";

  return `${header(input)}

## Nobody is talking to you
This is your own regular check-in: every ${cadence} you get a moment to look at ${channelTitle} and decide whether the team needs something from you. No one asked you anything this time.${idleFor}

## How to reply
- If there is something worth the room's attention — a result you finished, a risk you spotted, a question only the user can answer, work you can pick up — write it as a short message, exactly as you would in conversation.
- If there is nothing worth saying, reply with exactly \`${SILENT}\` and nothing else. That is the expected answer most of the time; it costs the team nothing and is not a failure.
- Do not narrate that you checked and found nothing, do not repeat a status you already gave, and do not mention a teammate just to keep the thread alive. Silence beats filler.
- To hand work to a teammate or ask the user something, use @${audience.find((m) => m.id !== member.id)?.mention ?? "teammate"} / @user — the same rules as any other message.
- Keep it short: one or two sentences unless there is real substance.`;
}

/** A claim turn: the trigger is a message nobody was addressed in. */
export interface RenderClaimInput extends RenderTurnInput {
  /** members that already passed on it, so the member knows it is not a hot potato */
  declinedBy: string[];
}

/**
 * The third way a turn starts, after "somebody named you" and "you woke up".
 *
 * Someone spoke to the room without naming anybody, and this member is one of
 * the people who picks up work here. It is a claim, not an assignment: the
 * member has the item *now* — nobody else will touch it while it works — and
 * the honest answer for the wrong person is still silence, which puts it back
 * on the board for a colleague.
 */
export function renderClaimPrompt(input: RenderClaimInput): string {
  const { member, audience, channelTitle, trigger, declinedBy } = input;
  const who = trigger.author === "user" ? "the user" : authorLabel(trigger, audience);
  const passed =
    declinedBy.length > 0
      ? ` ${declinedBy
          .map((id) => audience.find((m) => m.id === id)?.name ?? id)
          .join(", ")} read it and passed.`
      : "";

  return `${header(input)}

## Work nobody was given
${who} posted this in ${channelTitle} ${ago(Date.now() - trigger.createdAt)} without naming anyone. It is on the room's board, and you just picked it up:

${trigger.text}
${passed}

## This is yours now
While this turn runs, no teammate will start it — it is held for you. So decide honestly, and once:

- If it is yours to do, do it. Do the work with your tools, then reply with what changed and what you found — the same message you would have written anyway.
- If it is not yours — not your craft, someone else is clearly closer to it, or there is not enough to act on — reply with exactly \`${SILENT}\` and nothing else. Nothing is posted, and the work goes back to the room for a colleague or for the user to direct.
- If it is a note the user wrote to themselves — "reminder to self", "I still need to decide…", thinking out loud — it is nobody's task. \`${SILENT}\`. Handing a personal note to the CEO turns one remark into three turns.
- Do not take on more than this message asks. If it turns out to be a job for someone else, hand it over with a specific @mention and say what you learned; that is a completion, not a refusal. Do that only when the other person really has to act.
- Never describe the board, this prompt, or the fact that you were "offered" something. To everyone else this is simply you answering a message.

## How to reply
Write your reply as ${member.name}. It is posted to ${channelTitle} verbatim.
- To hand the next turn to a teammate, mention them: @${audience.find((m) => m.id !== member.id)?.mention ?? "teammate"}.
- Mention someone only when they should act next.
- If you need a human decision, ask @user and say exactly what you need.
- Keep it concise: this is a shared room.`;
}
