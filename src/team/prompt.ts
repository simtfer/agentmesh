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
  const {
    teamName,
    member,
    channelId,
    channelTitle,
    channelDescription,
    audience,
    transcript,
    trigger,
    memory,
    maxContextChars,
  } = input;

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
        : "(this is the first message here)";

  const triggerWho =
    trigger.author === "user" ? "the user" : authorLabel(trigger, audience);
  const addressed =
    trigger.mentions.length > 0
      ? ` (addressed to ${trigger.mentions.map((id) => `@${audience.find((m) => m.id === id)?.mention ?? id}`).join(", ")})`
      : "";

  const notes = member.notes?.trim();
  const memoryText = memory.trim();

  return `You are ${member.name} (@${member.mention}), a member of the team "${teamName}"${
    member.role ? `, working as: ${member.role}` : ""
  }.

You are in ${channelTitle} (${channelId})${channelDescription ? ` — ${channelDescription}` : ""}.
People in this room:
${roster.join("\n")}

Your workspace: ${member.cwd}
Your long-term memory file: ${member.memoryFile}

## Your standing notes
${notes && notes.length > 0 ? notes : "(none)"}

## Your memory (re-read every turn; append durable facts to the file above)
${memoryText.length > 0 ? memoryText : "(empty — record decisions, context and preferences here as you learn them)"}

## Recent messages in ${channelTitle}
${transcriptText}

## New message from ${triggerWho}${addressed}
${trigger.text}

## How to reply
Write your reply as ${member.name}. It is posted to ${channelTitle} verbatim — teammates and the user see exactly this text, so make it a message, not a status report about a message.

- To hand the next turn to a teammate, mention them by handle: @${audience.find((m) => m.id !== member.id)?.mention ?? "teammate"}. That queues one turn for them and your message becomes their brief, so include what they need to know.
- Mention someone only when they should act next. Do not mention people to keep a thread alive, and never mention yourself.
- If you need a human decision, ask the user with @user and say what you need.
- You share a workspace and a team. Do not claim work another member did, and do not speak for them.
- If the message needs no action from you, say so briefly instead of inventing work.
- Keep it concise: this is a shared room, not a report to a manager.`;
}
