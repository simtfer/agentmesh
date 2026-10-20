import { createInterface } from "node:readline/promises";
import type { MeshConfig } from "../types.js";
import { Orchestrator } from "../orchestrator.js";
import { startTeamServer } from "./server.js";
import { Team } from "./team.js";
import type {
  TeamChannelState,
  TeamMemberState,
  TeamMessage,
  TeamStatus,
  TeamTranscriptEntry,
  TeamTurn,
} from "./types.js";

const DEFAULT_URL = "http://127.0.0.1:4317";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TeamCommandArgs {
  sub?: string;
  rest: string[];
  url?: string;
  tokenEnv?: string;
  limit?: number;
  follow?: boolean;
  wait?: boolean;
  host?: string;
  port?: number;
  content?: string;
}

type PendingApproval = {
  approvalId: string;
  memberId: string;
  turnId: string;
  taskId: string;
  kind: "permission" | "elicitation";
};

type StatusPayload = TeamStatus & { approvals: PendingApproval[] };

const hhmm = (ts: number) => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

function baseUrl(args: TeamCommandArgs): string {
  return (args.url ?? process.env.AGENTMESH_TEAM_URL ?? DEFAULT_URL).replace(/\/+$/, "");
}

function tokenFor(args: TeamCommandArgs): string | undefined {
  const name = args.tokenEnv ?? "AGENTMESH_TEAM_TOKEN";
  return process.env[name] || undefined;
}

async function request<T>(args: TeamCommandArgs, path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.body ? { "content-type": "application/json" } : {}) };
  const token = tokenFor(args);
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${baseUrl(args)}${path}`, { ...init, headers });
  } catch {
    throw new Error(
      `cannot reach the team server at ${baseUrl(args)} — start it with \`agentmesh team serve\``,
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`team server returned ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return (await res.json()) as T;
}

function printMessage(m: TeamMessage): void {
  const who = m.author === "user" ? "you" : m.author === "system" ? "·" : m.authorName;
  const prefix = m.author === "system" ? "" : `[${hhmm(m.createdAt)}] `;
  const text = m.author === "system" ? `   · ${m.text}` : `   ${prefix}${who}: ${m.text}`;
  process.stdout.write(`${text}\n`);
}

function printMembers(members: TeamMemberState[]): void {
  for (const m of members) {
    const worker = m.workerId ? ` worker=${m.workerId}` : "";
    const queued = m.queued > 0 ? ` queued=${m.queued}` : "";
    process.stdout.write(
      `   ${m.id.padEnd(10)} ${m.status.padEnd(8)} @${m.mention.padEnd(10)} ${m.profile}${worker}${queued}\n`,
    );
  }
}

function printChannels(channels: TeamChannelState[]): void {
  for (const c of channels) {
    const last = c.lastMessageAt ? `last ${hhmm(c.lastMessageAt)}` : "empty";
    process.stdout.write(`   ${c.id.padEnd(18)} ${String(c.messageCount).padStart(4)} msg  ${last}  ${c.title}\n`);
  }
}

function printStatus(s: StatusPayload): void {
  process.stdout.write(
    `${s.team} · ${s.members.length} members · ${s.running} running, ${s.queued} queued, ${s.waiting} waiting · hops≤${s.maxHops}\n`,
  );
  printMembers(s.members);
  printChannels(s.channels);
  for (const a of s.approvals) {
    process.stdout.write(`   ! ${a.kind} ${a.approvalId} blocks ${a.memberId} (turn ${a.turnId})\n`);
  }
  if (s.approvals.some((a) => a.kind === "permission")) {
    process.stdout.write(`   answer with: agentmesh team approve <approvalId> allow_once\n`);
  }
  if (s.approvals.some((a) => a.kind === "elicitation")) {
    process.stdout.write(`   answer with: agentmesh team respond <approvalId> accept --content '{"answer":"..."}'\n`);
  }
}

function printTranscript(entries: TeamTranscriptEntry[]): void {
  if (entries.length === 0) {
    process.stdout.write("   (no turns yet)\n");
    return;
  }
  for (const t of entries) {
    process.stdout.write(
      `\n   ${t.id}  ${t.memberId}  ${t.status}${t.taskId ? `  task=${t.taskId}` : ""}\n`,
    );
    process.stdout.write(
      `   ${hhmm(t.queuedAt)} → ${t.endedAt ? hhmm(t.endedAt) : "running"}  hops=${t.hops}  ${t.channel}\n`,
    );
    if (t.error) process.stdout.write(`   error: ${t.error}\n`);
    for (const e of t.events) process.stdout.write(`     ${eventLine(e)}\n`);
  }
}

/** One event, one line: merged prose gets more room than a tool call. */
function eventLine(e: TeamTranscriptEntry["events"][number]): string {
  const kind = String((e.data as { kind?: unknown } | undefined)?.kind ?? e.type);
  const stream = String((e.data as { stream?: unknown } | undefined)?.stream ?? "");
  const chunks = Number((e.data as { chunks?: unknown } | undefined)?.chunks ?? 1);
  // Report the real stream (`thought`, `output`) rather than flattening both to
  // "text": reasoning and the answer are different things to watch.
  const base = kind === "text" && stream && stream !== "output" ? stream : kind;
  const width = kind === "text" ? 400 : 160;
  const flat = (e.text ?? "").replace(/\s+/g, " ").trim();
  const body = flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
  const label = chunks > 1 ? `${base}×${chunks}` : base;
  return `${label.padEnd(8)} ${body}`;
}

async function messageTail(args: TeamCommandArgs, channel: string, after: number, limit = 200): Promise<TeamMessage[]> {
  const q = new URLSearchParams({ channel, after: String(after), limit: String(limit) });
  const r = await request<{ messages: TeamMessage[] }>(args, `/team/messages?${q.toString()}`);
  return r.messages;
}

async function lastSeq(args: TeamCommandArgs, channel: string): Promise<number> {
  const [m] = await messageTail(args, channel, 0, 1);
  return m?.seq ?? 0;
}

const TERMINAL_TURN = new Set(["succeeded", "failed", "cancelled"]);

async function turnStates(args: TeamCommandArgs, ids: string[]): Promise<Array<TeamTurn | undefined>> {
  const out: Array<TeamTurn | undefined> = [];
  for (const id of ids) {
    try {
      out.push((await request<{ turn: TeamTurn }>(args, `/team/turns/${encodeURIComponent(id)}`)).turn);
    } catch {
      out.push(undefined);
    }
  }
  return out;
}

/**
 * Print whatever the room produced since `after`, then follow *this* request to
 * its end. Two conditions have to hold: the turns the message created are
 * terminal, and nothing else in the team is still working (a reply can mention
 * the next teammate, so the chain outlives the first turn).
 *
 * Tracking turn ids is what removes the race where `--wait` returned before the
 * member had even started. Approval-blocked turns end the wait: the human has to
 * act, and a CLI that hangs forever would look like a bug.
 */
async function drain(
  args: TeamCommandArgs,
  channel: string,
  after: number,
  turnIds: string[] = [],
): Promise<void> {
  let cursor = after;
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const batch = await messageTail(args, channel, cursor);
    for (const m of batch) printMessage(m);
    if (batch.length > 0) cursor = batch[batch.length - 1]!.seq;

    const [states, s] = await Promise.all([
      turnIds.length > 0 ? turnStates(args, turnIds) : Promise.resolve([]),
      request<StatusPayload>(args, "/team"),
    ]);
    const started = turnIds.length === 0 || states.every((t) => t && TERMINAL_TURN.has(t.status));
    const blocked = states.some((t) => t?.status === "waiting" && t.approvalId);
    const quiet = s.running === 0 && s.queued === 0;

    if (blocked || (started && quiet)) {
      for (const a of s.approvals) {
        process.stdout.write(`   ! ${a.kind} ${a.approvalId} blocks ${a.memberId}\n`);
      }
      if (s.approvals.length > 0) {
        process.stdout.write(
          `   waiting on you: agentmesh team approve <id> allow_once  ·  agentmesh team respond <id> accept\n`,
        );
      }
      return;
    }

    if (Date.now() > deadline) {
      process.stdout.write("   (still working — check `agentmesh team status`)\n");
      return;
    }
    await sleep(350);
  }
}

async function cmdServe(args: TeamCommandArgs, loadConfig: () => Promise<MeshConfig>): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.team) throw new Error("config has no `team:` section — add a roster (see docs/team.md)");
  const orch = new Orchestrator(cfg, { baseCwd: process.cwd() });
  const team = new Team({ config: cfg.team, orchestrator: orch, baseCwd: process.cwd() });
  const tokenEnv = args.tokenEnv ?? cfg.team.tokenEnv ?? "AGENTMESH_TEAM_TOKEN";
  const token = process.env[tokenEnv];
  const server = await startTeamServer({
    team,
    host: args.host ?? cfg.team.host ?? "127.0.0.1",
    port: args.port ?? cfg.team.port ?? 4317,
    ...(token ? { tokens: [token] } : {}),
  });

  process.stderr.write(
    `[agentmesh] team "${team.name}" listening on ${server.url}` +
      `${token ? ` (bearer token from ${tokenEnv})` : " (no auth — loopback only)"}\n`,
  );
  process.stderr.write(
    `[agentmesh] members: ${team.members.map((m) => `${m.name} (@${m.mention})`).join(", ")}\n`,
  );

  let stop!: () => void;
  const done = new Promise<void>((resolve) => (stop = resolve));
  const shutdown = (sig: string) => {
    process.stderr.write(`[agentmesh] ${sig} — closing the team\n`);
    stop();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  await done;
  await server.close().catch(() => {});
  await team.shutdown().catch(() => {});
  await orch.shutdown().catch(() => {});
}

async function cmdSay(args: TeamCommandArgs, dm: boolean): Promise<void> {
  const [target, ...words] = args.rest;
  const text = words.join(" ").trim();
  if (!target || !text) throw new Error(dm ? "usage: team dm <member> <text>" : "usage: team say <channel> <text>");
  const body = dm ? { to: target, text } : { channel: target, text };
  const { message, turns } = await request<{ message: TeamMessage; turns?: string[] }>(
    args,
    "/team/messages",
    { method: "POST", body: JSON.stringify(body) },
  );
  process.stdout.write(`   sent ${message.id} to ${message.channel}\n`);
  if (args.wait) await drain(args, message.channel, message.seq, turns ?? []);
}

async function cmdLog(args: TeamCommandArgs): Promise<void> {
  const channel = args.rest[0] ?? "general";
  const limit = args.limit ?? 50;
  let cursor = 0;
  const initial = await messageTail(args, channel, 0, limit);
  for (const m of initial) printMessage(m);
  cursor = initial[initial.length - 1]?.seq ?? 0;
  if (!args.follow) return;
  for (;;) {
    await sleep(800);
    const batch = await messageTail(args, channel, cursor);
    for (const m of batch) printMessage(m);
    if (batch.length > 0) cursor = batch[batch.length - 1]!.seq;
  }
}

async function cmdChat(args: TeamCommandArgs): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let channel = "general";
  let cursor = await lastSeq(args, channel);
  const s = await request<StatusPayload>(args, "/team");
  process.stdout.write(
    `${s.team}: ${s.members.map((m) => `${m.name} (@${m.mention})`).join(", ")}\n` +
      `talking in #general. /dm <member> <text>, /log, /members, /status, /transcript <member>, /quit\n\n`,
  );

  try {
    for (;;) {
      const raw = (await rl.question(`[${channel}] you> `)).trim();
      if (!raw) continue;
      if (raw === "/quit" || raw === "/exit") return;

      if (raw.startsWith("/dm ")) {
        const [member, ...words] = raw.slice(4).trim().split(/\s+/);
        if (!member) {
          process.stdout.write("   usage: /dm <member> <text>\n");
          continue;
        }
        channel = `dm:user:${member}`;
        cursor = await lastSeq(args, channel);
        const text = words.join(" ").trim();
        if (!text) {
          process.stdout.write(`   now talking in ${channel}\n`);
          continue;
        }
        const { message, turns } = await request<{ message: TeamMessage; turns?: string[] }>(
          args,
          "/team/messages",
          { method: "POST", body: JSON.stringify({ to: member, text }) },
        );
        await drain(args, channel, message.seq, turns ?? []);
        continue;
      }

      if (raw === "/general") {
        channel = "general";
        cursor = await lastSeq(args, channel);
        process.stdout.write(`   now talking in #general\n`);
        continue;
      }

      if (raw === "/log") {
        const limit = args.limit ?? 30;
        const tail = await messageTail(args, channel, 0, limit);
        for (const m of tail) printMessage(m);
        cursor = tail[tail.length - 1]?.seq ?? cursor;
        continue;
      }

      if (raw === "/members") {
        printMembers((await request<StatusPayload>(args, "/team")).members);
        continue;
      }

      if (raw === "/status") {
        printStatus(await request<StatusPayload>(args, "/team"));
        continue;
      }

      if (raw.startsWith("/transcript")) {
        const member = raw.split(/\s+/)[1];
        if (!member) {
          process.stdout.write("   usage: /transcript <member>\n");
          continue;
        }
        const r = await request<{ turns: TeamTranscriptEntry[] }>(
          args,
          `/team/members/${encodeURIComponent(member)}/transcript?limit=5`,
        );
        printTranscript(r.turns);
        continue;
      }

      if (raw.startsWith("/")) {
        process.stdout.write("   commands: /dm <member> <text>, /general, /log, /members, /status, /transcript <member>, /quit\n");
        continue;
      }

      const { message, turns } = await request<{ message: TeamMessage; turns?: string[] }>(
        args,
        "/team/messages",
        { method: "POST", body: JSON.stringify({ channel, text: raw }) },
      );
      if (channel !== message.channel) channel = message.channel;
      await drain(args, channel, message.seq, turns ?? []);
    }
  } finally {
    rl.close();
  }
}

async function cmdTranscript(args: TeamCommandArgs): Promise<void> {
  const member = args.rest[0];
  if (!member) throw new Error("usage: team transcript <member>");
  const r = await request<{ turns: TeamTranscriptEntry[] }>(
    args,
    `/team/members/${encodeURIComponent(member)}/transcript?limit=${args.limit ?? 10}`,
  );
  printTranscript(r.turns);
}

async function cmdRespond(args: TeamCommandArgs): Promise<void> {
  const [approvalId, action] = args.rest;
  const allowed = ["accept", "decline", "cancel"] as const;
  if (!approvalId || !action || !(allowed as readonly string[]).includes(action)) {
    throw new Error("usage: team respond <approvalId> <accept|decline|cancel> [--content '<json>']");
  }
  let content: unknown = null;
  if (args.content) {
    try {
      content = JSON.parse(args.content);
    } catch {
      throw new Error("--content must be valid JSON, e.g. --content '{\"answer\":\"yes\"}'");
    }
  }
  const r = await request<{ resolved: boolean }>(args, "/team/approvals", {
    method: "POST",
    body: JSON.stringify({ approvalId, action, content }),
  });
  process.stdout.write(`   ${r.resolved ? "answered" : "not found"}: ${approvalId}\n`);
}

async function cmdApprove(args: TeamCommandArgs): Promise<void> {
  const [approvalId, decision] = args.rest;
  if (!approvalId) throw new Error("usage: team approve <approvalId> <allow_once|allow_always|reject_once|reject_always|cancel>");
  const r = await request<{ resolved: boolean }>(args, "/team/approvals", {
    method: "POST",
    body: JSON.stringify({ approvalId, decision: decision ?? "allow_once" }),
  });
  process.stdout.write(`   ${r.resolved ? "approved" : "not found"}: ${approvalId}\n`);
}

export async function runTeamCommand(
  args: TeamCommandArgs,
  loadConfig: () => Promise<MeshConfig>,
): Promise<void> {
  switch (args.sub) {
    case "serve":
      return cmdServe(args, loadConfig);
    case "chat":
      return cmdChat(args);
    case "say":
      return cmdSay(args, false);
    case "dm":
      return cmdSay(args, true);
    case "log":
    case "watch":
      return cmdLog(args);
    case "status": {
      printStatus(await request<StatusPayload>(args, "/team"));
      return;
    }
    case "members": {
      printMembers((await request<StatusPayload>(args, "/team")).members);
      return;
    }
    case "channels": {
      printChannels((await request<StatusPayload>(args, "/team")).channels);
      return;
    }
    case "transcript":
      return cmdTranscript(args);
    case "approve":
      return cmdApprove(args);
    case "respond":
      return cmdRespond(args);
    default:
      process.stdout.write(
        `team — run named members in shared rooms\n\n` +
          `  agentmesh team serve [--config f] [--host h] [--port p] [--token-env VAR]\n` +
          `  agentmesh team chat                     interactive group chat + DMs\n` +
          `  agentmesh team say <channel> "text" [--wait]\n` +
          `  agentmesh team dm <member> "text" [--wait]\n` +
          `  agentmesh team log [channel] [--limit N] [--follow]\n` +
          `  agentmesh team members | channels | status\n` +
          `  agentmesh team transcript <member> [--limit N]\n` +
          `  agentmesh team approve <approvalId> <decision>\n` +
          `  agentmesh team respond <approvalId> <accept|decline|cancel> [--content json]\n\n` +
          `  client target: --url http://host:port or AGENTMESH_TEAM_URL\n` +
          `  token:         AGENTMESH_TEAM_TOKEN (or --token-env NAME)\n`,
      );
  }
}
