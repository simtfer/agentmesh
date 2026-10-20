import path from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import type { Orchestrator } from "../orchestrator.js";
import type { TaskEvent, TaskRecord } from "../types.js";
import { isTerminal } from "../statemachine.js";
import { TeamStore } from "./store.js";
import { extractHandles, resolveMentions } from "./mentions.js";
import { renderTurnPrompt } from "./prompt.js";
import type {
  TeamChannelConfig,
  TeamChannelState,
  TeamConfig,
  TeamMember,
  TeamMemberState,
  TeamMessage,
  TeamMessageKind,
  TeamStatus,
  TeamTranscriptEntry,
  TeamTurn,
} from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Hard ceiling on a single message, to keep one paste from bloating the log. */
const MAX_MESSAGE_CHARS = 20_000;
/** How much of a member's MEMORY.md is injected into each turn. */
const MAX_MEMORY_CHARS = 4_000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

export interface TeamOptions {
  config: TeamConfig;
  orchestrator: Orchestrator;
  /** directory member workspaces resolve against (default: process.cwd()) */
  baseCwd?: string;
  /** override `team.stateDir` */
  stateDir?: string;
  /** false = in-memory store (tests, demos) */
  persist?: boolean;
}

export interface PostInput {
  /** channel id; `general` when omitted. Use `dm:<member>` for a private thread. */
  channel?: string;
  text: string;
  /** member id, `user` (default) or `system` */
  author?: string;
  authorName?: string;
  kind?: TeamMessageKind;
  /** internal: depth in the hand-off chain (a reply is parent + 1) */
  hops?: number;
  /** internal: the user message this thread started from */
  rootId?: string;
  replyTo?: string;
  turnId?: string;
}

interface ResolvedChannel {
  id: string;
  kind: "channel" | "dm";
  title: string;
  description?: string;
  members: TeamMember[];
}

/**
 * The team layer: named members talking in rooms.
 *
 * The structural decision is that a turn is *just a message being answered*,
 * not a job with a payload. That is what lets the same member be addressed by
 * the user, by a teammate, or by nobody in particular, while every hand-off
 * stays visible in the transcript. Underneath, a turn is one agentmesh task on
 * the member's pinned session — so conversation history, approvals, transcripts
 * and cost accounting all come from the existing machinery instead of a
 * parallel implementation.
 *
 * Scheduling is deliberately conservative: one turn at a time per member (a
 * transcript must not interleave), but members run in parallel with each other.
 * That is the difference between a queue of jobs and a room full of people.
 */
export class Team {
  readonly name: string;
  readonly stateDir: string;
  readonly members: TeamMember[];
  readonly maxHops: number;
  readonly maxTurnsPerMessage: number;
  readonly turnTimeoutMs: number;

  private readonly orch: Orchestrator;
  private readonly store: TeamStore;
  private readonly channelConfigs: TeamChannelConfig[];
  private readonly contextMessages: number;
  private readonly maxContextChars: number;
  /** memberId → turnId currently in flight in this process */
  private readonly running = new Map<string, string>();
  private closed = false;
  private pumpScheduled = false;

  constructor(opts: TeamOptions) {
    const cfg = opts.config;
    this.orch = opts.orchestrator;
    this.name = (cfg.name ?? "team").trim() || "team";
    this.maxHops = Math.max(1, Math.trunc(cfg.maxHops ?? 6));
    this.maxTurnsPerMessage = Math.max(1, Math.trunc(cfg.maxTurnsPerMessage ?? 16));
    this.contextMessages = Math.max(1, Math.trunc(cfg.contextMessages ?? 20));
    this.maxContextChars = Math.max(1000, Math.trunc(cfg.maxContextChars ?? 6000));
    this.turnTimeoutMs = Math.max(1000, Math.trunc(cfg.turnTimeoutMs ?? 15 * 60_000));

    const baseCwd = path.resolve(opts.baseCwd ?? process.cwd());
    this.stateDir = path.resolve(opts.stateDir ?? cfg.stateDir ?? path.join(this.orch.workdir, "team"));

    const profiles = new Set(this.orch.config.profiles.map((p) => p.name));
    const ids = new Set<string>();
    /** every addressable handle → member id; catches id/mention collisions */
    const handles = new Map<string, string>();
    this.members = (cfg.members ?? []).map((m) => {
      if (!ID_PATTERN.test(m.id)) {
        throw new Error(`team member id "${m.id}" is not a valid handle: use letters, digits, "-" or "_"`);
      }
      if (ids.has(m.id)) throw new Error(`duplicate team member id: ${m.id}`);
      ids.add(m.id);
      if (!profiles.has(m.profile)) {
        throw new Error(
          `team member "${m.id}" uses unknown profile "${m.profile}"; known profiles: ${[
            ...profiles,
          ].join(", ")}`,
        );
      }
      const mention = (m.mention ?? m.id).replace(/^@/, "");
      if (!ID_PATTERN.test(mention)) {
        throw new Error(`team member "${m.id}" has an invalid mention handle: ${mention}`);
      }
      for (const handle of new Set([m.id.toLowerCase(), mention.toLowerCase()])) {
        const owner = handles.get(handle);
        if (owner && owner !== m.id) {
          throw new Error(`handle "@${handle}" is claimed by both "${owner}" and "${m.id}"`);
        }
        handles.set(handle, m.id);
      }
      const defaultCwd = path.resolve(baseCwd, cfg.cwd ?? ".");
      return {
        id: m.id,
        name: (m.name ?? m.id).trim() || m.id,
        ...(m.role ? { role: m.role } : {}),
        mention,
        profile: m.profile,
        cwd: m.cwd ? path.resolve(defaultCwd, m.cwd) : defaultCwd,
        sessionKey: `team:${this.name}:${m.id}`,
        memoryFile: path.join(this.stateDir, "members", m.id, "MEMORY.md"),
        ...(m.notes ? { notes: m.notes } : {}),
      } satisfies TeamMember;
    });
    if (this.members.length === 0) throw new Error("team.members is empty: a team needs at least one member");
    for (const m of this.members) mkdirSync(path.dirname(m.memoryFile), { recursive: true });

    this.channelConfigs = cfg.channels?.length ? cfg.channels : [{ id: "general" }];
    const channelIds = new Set<string>();
    for (const c of this.channelConfigs) {
      if (!ID_PATTERN.test(c.id)) {
        throw new Error(`channel id "${c.id}" is not a valid name: use letters, digits, "-" or "_"`);
      }
      if (c.id.startsWith("dm:")) throw new Error(`channel id "${c.id}" may not start with "dm:"`);
      if (channelIds.has(c.id)) throw new Error(`duplicate channel id: ${c.id}`);
      channelIds.add(c.id);
      for (const id of c.members ?? []) {
        if (!ids.has(id)) throw new Error(`channel "${c.id}" lists unknown member "${id}"`);
      }
    }

    this.store = new TeamStore(
      opts.persist === false ? ":memory:" : path.join(this.stateDir, "team.sqlite"),
    );

    // Recover from an unclean stop before accepting new messages. A turn that
    // was in flight cannot be replayed safely — it may already have edited
    // files — so it is failed *visibly* in its channel; queued turns were never
    // started and are kept, then picked up by the pump below.
    const interrupted = this.store.interruptLiveTurns(
      "interrupted: the team process stopped while this turn was running",
    );
    for (const t of interrupted) {
      const member = this.member(t.memberId);
      if (!member) continue;
      this.store.createMessage({
        channel: t.channel,
        author: "system",
        authorName: "system",
        kind: "system",
        text: `${member.name}'s previous turn was interrupted when the team process stopped. Nothing was posted for it; send the message again if you still need it.`,
      });
    }

    this.schedulePump();
  }

  /* ----------------------------- read side ----------------------------- */

  member(id: string): TeamMember | undefined {
    return this.members.find((m) => m.id === id);
  }

  channels(): TeamChannelState[] {
    const stats = new Map(this.store.channelStats().map((s) => [s.channel, s]));
    const out: TeamChannelState[] = this.channelConfigs.map((c) => {
      const stat = stats.get(c.id);
      return {
        id: c.id,
        kind: "channel",
        title: `#${c.id}`,
        ...(c.description ? { description: c.description } : {}),
        members: (c.members ?? this.members.map((m) => m.id)).map(String),
        ...(stat ? { lastMessageAt: stat.lastAt, messageCount: stat.count } : { messageCount: 0 }),
      };
    });
    // DMs are not declared: they exist because someone spoke in one.
    for (const [channel, stat] of stats) {
      if (!channel.startsWith("dm:")) continue;
      out.push({
        id: channel,
        kind: "dm",
        title: `DM · ${this.dmParticipants(channel)
          .map((id) => this.member(id)?.name ?? id)
          .join(", ")}`,
        members: this.dmParticipants(channel),
        lastMessageAt: stat.lastAt,
        messageCount: stat.count,
      });
    }
    return out;
  }

  messages(channel = "general", limit = 50, afterSeq = 0): TeamMessage[] {
    this.channelState(channel); // validate
    return this.store.listMessages(channel, Math.max(1, limit), Math.max(0, afterSeq));
  }

  status(): TeamStatus {
    const counts = this.store.openTurnCounts();
    const lastSpoke = this.store.memberLastSpoke();
    const members: TeamMemberState[] = this.members.map((m) => {
      const currentId = this.running.get(m.id);
      const current = currentId ? this.store.getTurn(currentId) : undefined;
      const queued = this.store.countQueued(m.id);
      const task = current?.taskId ? this.orch.taskStatus(current.taskId) : undefined;
      // Between turns the task record is gone but the pinned worker usually is
      // not: report the live process, so "who is at their desk" is answerable.
      const workerId = task?.workerId ?? this.orch.getWorkerBySessionKey(m.sessionKey)?.id;
      const status: TeamMemberState["status"] =
        current?.status === "waiting" ? "waiting" : current ? "running" : queued > 0 ? "queued" : "idle";
      return {
        ...m,
        status,
        queued,
        ...(current ? { currentTurnId: current.id } : {}),
        ...(current?.taskId ? { taskId: current.taskId } : {}),
        ...(workerId ? { workerId } : {}),
        ...(lastSpoke.has(m.id) ? { lastMessageAt: lastSpoke.get(m.id) } : {}),
      };
    });
    return {
      team: this.name,
      stateDir: this.stateDir,
      members,
      channels: this.channels(),
      queued: counts.queued,
      running: counts.running,
      waiting: counts.waiting,
      maxHops: this.maxHops,
      maxTurnsPerMessage: this.maxTurnsPerMessage,
    };
  }

  /**
   * One member's turns with the task events behind them. This is the "look over
   * their shoulder" view: channel messages answer *what was said*, this answers
   * *what the agent did* — tool calls, waiting states, failures.
   */
  transcript(memberId: string, limit = 20): TeamTranscriptEntry[] {
    if (!this.member(memberId)) throw new Error(`no such team member: ${memberId}`);
    return this.store.listTurns({ memberId, limit: Math.max(1, limit) }).map((t) => {
      const task = t.taskId ? this.orch.taskStatus(t.taskId) : undefined;
      return {
        ...t,
        ...(task ? { taskStatus: task.status } : {}),
        events: t.taskId ? this.visibleEvents(this.orch.taskEvents(t.taskId)) : [],
      };
    });
  }

  /** One turn by id — used by the CLI to follow exactly the work it started. */
  turn(id: string): TeamTurn | undefined {
    return this.store.getTurn(id);
  }

  /** Requests currently blocking a member (permission or elicitation). */
  approvals(): Array<{
    approvalId: string;
    memberId: string;
    turnId: string;
    taskId: string;
    kind: "permission" | "elicitation";
  }> {
    const out: Array<{
      approvalId: string;
      memberId: string;
      turnId: string;
      taskId: string;
      kind: "permission" | "elicitation";
    }> = [];
    for (const [memberId, turnId] of this.running) {
      const turn = this.store.getTurn(turnId);
      if (!turn?.taskId) continue;
      for (const a of this.orch.pendingApprovals(turn.taskId)) {
        out.push({ approvalId: a.id, memberId, turnId, taskId: turn.taskId, kind: a.kind });
      }
    }
    return out;
  }

  /**
   * Resolves when nothing can make progress without a human: no queued turns,
   * no running turns, and every `waiting` turn still has an unanswered approval.
   * A turn whose approval was just resolved is *not* quiescent — its agent is
   * running again even though the row has not reached a terminal state yet.
   */
  async idle(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const counts = this.store.openTurnCounts();
      if (counts.queued === 0 && counts.running === 0) {
        const waiting = this.store.listTurns({ status: "waiting", limit: 500 });
        if (waiting.length === 0) return;
        const blocked = new Set(
          this.orch.pendingApprovals().map((a) => a.taskId).filter(Boolean),
        );
        if (waiting.every((t) => t.taskId && blocked.has(t.taskId))) return;
      }
      await sleep(50);
    }
    throw new Error(`team did not become idle within ${timeoutMs}ms`);
  }

  /* ----------------------------- write side ---------------------------- */

  /**
   * Post a message and queue the turns it asks for. The call returns as soon as
   * the message is durable; members work in the background, exactly like people
   * in a room. Use `idle()` (or the HTTP status endpoint) to observe.
   */
  post(input: PostInput): TeamMessage {
    return this.postWithTurns(input).message;
  }

  /**
   * Same as `post`, but also returns the turns it created. Callers that need to
   * follow a specific message (`team say --wait`) get a precise handle instead of
   * guessing when the work is done from a global "is anything running" flag.
   */
  postWithTurns(input: PostInput): { message: TeamMessage; turns: TeamTurn[] } {
    if (this.closed) throw new Error("team is shut down");
    const text = input.text?.trim();
    if (!text) throw new Error("message text is required");
    if (text.length > MAX_MESSAGE_CHARS) {
      throw new Error(`message too long (${text.length} > ${MAX_MESSAGE_CHARS} chars)`);
    }
    const channel = this.channelState(input.channel ?? "general");
    const author = input.author ?? "user";
    const kind = input.kind ?? "chat";
    if (author !== "user" && author !== "system" && !this.member(author)) {
      throw new Error(`unknown message author: ${author}`);
    }

    // Who can be addressed here? A channel has a fixed membership; a DM starts
    // with its participants and may pull in any teammate, so an introduced
    // colleague stays reachable in that thread.
    const pool = channel.kind === "dm" ? this.members : channel.members;
    const resolved = resolveMentions(text, pool);
    const handles = extractHandles(text);
    // `@all` is a broadcast, not a member handle; it wakes the room, still under
    // the same hop/turn caps as any other mention.
    const broadcast = handles.includes("all") || handles.includes("everyone");
    // A DM is addressed to its partner by definition — the user should not have
    // to write "@qa" in a window that only has qa in it. A one-person room works
    // the same way: with nobody else to name, the message is for them.
    const implicit =
      author === "user"
        ? channel.kind === "dm"
          ? channel.id
              .split(":")
              .slice(1)
              .filter((part) => part !== "user" && this.member(part))
          : channel.members.length === 1
            ? [channel.members[0]!.id]
            : []
        : [];
    const explicit = broadcast ? channel.members.map((m) => m.id) : resolved.members.map((m) => m.id);
    const mentions = [...new Set([...implicit, ...explicit])].filter(
      (id) => id !== author && this.member(id),
    );

    const msg = this.store.createMessage({
      channel: channel.id,
      author,
      authorName:
        input.authorName ??
        (author === "user" ? "user" : author === "system" ? "system" : this.member(author)!.name),
      kind,
      text,
      mentions,
      ...(input.hops !== undefined ? { hops: input.hops } : {}),
      ...(input.rootId ? { rootId: input.rootId } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
    });

    if (kind === "system") return { message: msg, turns: [] };

    const turns = this.route(msg, channel, resolved.unknown);
    // A user message that addresses nobody is a dead end; say so once rather than
    // letting it look like the team ignored them.
    if (author === "user" && mentions.length === 0 && channel.kind === "channel" && channel.members.length > 1) {
      this.systemMessage(
        channel.id,
        `nobody was addressed — mention someone (@${channel.members
          .slice(0, 3)
          .map((m) => m.mention)
          .join(", @")}${channel.members.length > 3 ? ", …" : ""}) or @all.`,
      );
    }
    return { message: msg, turns };
  }

  /** Start (or continue) a private thread with one member. */
  dm(memberId: string, text: string, author = "user"): TeamMessage {
    return this.dmWithTurns(memberId, text, author).message;
  }

  dmWithTurns(
    memberId: string,
    text: string,
    author = "user",
  ): { message: TeamMessage; turns: TeamTurn[] } {
    if (!this.member(memberId)) throw new Error(`no such team member: ${memberId}`);
    return this.postWithTurns({ channel: `dm:user:${memberId}`, text, author });
  }

  approve(
    approvalId: string,
    decision: "allow_once" | "allow_always" | "reject_once" | "reject_always" | "cancel",
  ): boolean {
    return this.orch.approveTask(approvalId, decision);
  }

  /** Answer an elicitation (a member asking the user a question). */
  respond(
    approvalId: string,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown> | null,
  ): boolean {
    return this.orch.respondTask(approvalId, { action, content: content ?? null });
  }

  /* ------------------------------ routing ----------------------------- */

  /**
   * Turn mentions into queued turns, with the two caps that keep a room of
   * agents from talking forever: depth (`maxHops`) and total work per root
   * message (`maxTurnsPerMessage`). Both are counted, not guessed, so a
   * ping-pong terminates with an explanation in-channel instead of a hang.
   */
  private route(msg: TeamMessage, channel: ResolvedChannel, unknownHandles: string[]): TeamTurn[] {
    const targets = msg.mentions
      .map((id) => this.member(id))
      .filter((m): m is TeamMember => Boolean(m) && m!.id !== msg.author);
    const skipped: string[] = [];
    const created: TeamTurn[] = [];

    for (const target of targets) {
      if (msg.hops >= this.maxHops) {
        skipped.push(`@${target.mention} (hand-off depth ${this.maxHops} reached)`);
        continue;
      }
      if (this.store.countTurnsForRoot(msg.rootId) >= this.maxTurnsPerMessage) {
        skipped.push(`@${target.mention} (turn cap ${this.maxTurnsPerMessage} for this thread reached)`);
        continue;
      }
      if (this.store.hasQueuedTurn(target.id, msg.id)) continue;
      created.push(
        this.store.createTurn({
          memberId: target.id,
          channel: channel.id,
          messageId: msg.id,
          rootId: msg.rootId,
          hops: msg.hops,
        }),
      );
    }

    if (skipped.length > 0) {
      this.systemMessage(
        channel.id,
        `not queued: ${skipped.join("; ")}. The thread continues, but these hand-offs would exceed the team's safety limits.`,
      );
    }

    // A member may mention a teammate who is not in a restricted room. Say so
    // instead of dropping it: silent non-delivery looks like the teammate
    // ignored the request.
    const absent = unknownHandles.filter((h) =>
      this.members.some((m) => m.mention.toLowerCase() === h || m.id.toLowerCase() === h),
    );
    if (absent.length > 0 && channel.kind === "channel") {
      this.systemMessage(
        channel.id,
        `not in ${channel.title}: ${absent.map((h) => `@${h}`).join(", ")} — invite them to this channel or talk to them in a DM.`,
      );
    }

    this.schedulePump();
    return created;
  }

  /* ---------------------------- scheduling ---------------------------- */

  private schedulePump(): void {
    if (this.pumpScheduled || this.closed) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  /**
   * Start every member that has queued work and no turn in flight. Members are
   * independent, so this does not await them; the only shared limit is the
   * orchestrator's concurrency cap, honoured here as backpressure so a member
   * is not refused inside TaskManager.
   */
  private pump(): void {
    if (this.closed) return;
    const cap = this.orch.config.limits?.maxConcurrentTasks ?? 0;
    for (const member of this.members) {
      if (this.running.has(member.id)) continue;
      if (cap > 0 && this.running.size >= cap) break;
      const turn = this.store.nextQueuedTurn(member.id);
      if (!turn) continue;
      this.running.set(member.id, turn.id);
      void this.runTurn(turn, member);
    }
  }

  private async runTurn(turn: TeamTurn, member: TeamMember): Promise<void> {
    const channel = this.channelState(turn.channel);
    const trigger = this.store.getMessage(turn.messageId);
    let final: TaskRecord | undefined;
    let taskId: string | undefined;

    try {
      if (!trigger) throw new Error(`the message this turn answers is gone (${turn.messageId})`);
      const prompt = this.buildPrompt(member, channel, trigger);
      const submitted = this.orch.submitTask({
        prompt,
        profile: member.profile,
        sessionKey: member.sessionKey,
        cwd: member.cwd,
        timeoutMs: this.turnTimeoutMs,
        metadata: { team: this.name, memberId: member.id, turnId: turn.id, channel: turn.channel },
      });
      taskId = submitted.taskId;
      this.patchTurn(turn.id, { taskId, status: "running", startedAt: Date.now() });

      final = await this.orch.waitTask(taskId, this.turnTimeoutMs + 5_000);
      // `waitTask` also resolves on `waiting`, because an approval is a state a
      // human must see. Keep polling so the member's queue advances only when
      // the turn is genuinely over.
      while (final && final.status === "waiting" && !this.closed) {
        const approval = this.orch.pendingApprovals(taskId)[0];
        this.patchTurn(turn.id, {
          status: "waiting",
          ...(approval ? { approvalId: approval.id } : {}),
        });
        final = await this.pollTerminal(taskId, turn.id);
      }
    } catch (err) {
      this.failTurn(turn, member, channel, err instanceof Error ? err.message : String(err));
      this.finish(member.id, turn.id);
      return;
    }

    if (this.closed) {
      this.finish(member.id, turn.id);
      return;
    }

    if (final && final.status === "succeeded") {
      const text = (final.text ?? "").trim();
      this.patchTurn(turn.id, { status: "succeeded", endedAt: Date.now() });
      // Release the slot before posting: the reply may mention a teammate, and
      // the pump must be free to start whoever is next.
      this.finish(member.id, turn.id);
      if (text.length === 0) {
        this.systemMessage(
          channel.id,
          `${member.name} finished their turn without a reply, so nothing was posted.`,
        );
        return;
      }
      this.post({
        channel: channel.id,
        text: text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}\n…(truncated)` : text,
        author: member.id,
        authorName: member.name,
        kind: "chat",
        hops: turn.hops + 1,
        rootId: turn.rootId,
        replyTo: turn.messageId,
        turnId: turn.id,
      });
      return;
    }

    if (final) {
      const code = final.error?.code ?? final.status;
      const detail = final.error?.message ?? "the agent did not finish successfully";
      this.patchTurn(turn.id, {
        status: final.status === "cancelled" ? "cancelled" : "failed",
        endedAt: Date.now(),
        error: `${code}: ${detail}`,
      });
      this.systemMessage(
        channel.id,
        `${member.name}'s turn ${final.status === "cancelled" ? "was cancelled" : "failed"} (${code}). ${detail}`,
      );
    } else {
      this.patchTurn(turn.id, {
        status: "failed",
        endedAt: Date.now(),
        error: "task record disappeared before it settled",
      });
      this.systemMessage(channel.id, `${member.name}'s turn ended with no task record.`);
    }

    this.finish(member.id, turn.id);
  }

  private async pollTerminal(taskId: string, turnId?: string): Promise<TaskRecord | undefined> {
    const deadline = Date.now() + this.turnTimeoutMs + 60_000;
    let lastStatus: string | undefined;
    while (!this.closed && Date.now() < deadline) {
      const rec = this.orch.taskStatus(taskId);
      if (!rec) return undefined;
      if (isTerminal(rec.status)) return rec;
      // Once an approval is resolved the task runs again. Flip the turn back to
      // `running` so `status` and `idle` do not report a member as blocked while
      // its agent is in fact working. One write per transition, not per poll.
      if (turnId && rec.status !== lastStatus) {
        lastStatus = rec.status;
        if (rec.status === "running" || rec.status === "starting") {
          this.patchTurn(turnId, { status: "running" });
        }
      }
      await sleep(200);
    }
    return this.orch.taskStatus(taskId);
  }

  private failTurn(turn: TeamTurn, member: TeamMember, channel: ResolvedChannel, message: string): void {
    this.patchTurn(turn.id, { status: "failed", endedAt: Date.now(), error: message });
    this.systemMessage(channel.id, `${member.name}'s turn could not start: ${message}`);
  }

  private finish(memberId: string, turnId: string): void {
    if (this.running.get(memberId) === turnId) this.running.delete(memberId);
    this.schedulePump();
  }

  private patchTurn(turnId: string, patch: Parameters<TeamStore["patchTurn"]>[1]): void {
    if (this.closed) return;
    try {
      this.store.patchTurn(turnId, patch);
    } catch {
      // shutting down
    }
  }

  private systemMessage(channel: string, text: string): void {
    if (this.closed) return;
    try {
      this.store.createMessage({
        channel,
        author: "system",
        authorName: "system",
        kind: "system",
        text,
      });
    } catch {
      // shutting down
    }
  }

  /* ------------------------------ rendering ---------------------------- */

  private buildPrompt(member: TeamMember, channel: ResolvedChannel, trigger: TeamMessage): string {
    const history = this.store
      .listMessages(channel.id, this.contextMessages, 0)
      .filter((m) => m.seq < trigger.seq);
    return renderTurnPrompt({
      teamName: this.name,
      member,
      channelId: channel.id,
      channelTitle: channel.title,
      ...(channel.description ? { channelDescription: channel.description } : {}),
      audience: channel.members,
      transcript: history,
      trigger,
      memory: this.readMemory(member),
      maxContextChars: this.maxContextChars,
    });
  }

  private readMemory(member: TeamMember): string {
    try {
      return readFileSync(member.memoryFile, "utf8").slice(0, MAX_MEMORY_CHARS);
    } catch {
      return "";
    }
  }

  /**
   * Task events, shaped for reading.
   *
   * A streaming driver reports one `output` event per text delta, so a raw dump
   * reads like a wall of fragments — the opposite of "watch what this member is
   * doing". Consecutive deltas on the same stream are folded into one line, and
   * the fold is capped to the last 60 *lines* rather than 60 raw events so a
   * chatty member does not push its tool calls out of view. Tool and status
   * events stay one-per-line because each one is a distinct action.
   */
  private visibleEvents(events: TaskEvent[]): TeamTranscriptEntry["events"] {
    const out: TeamTranscriptEntry["events"] = [];
    let open: { first: TaskEvent; stream: string; text: string; chunks: number } | undefined;

    const flush = (): void => {
      if (!open) return;
      out.push({
        sequence: open.first.sequence,
        type: "output",
        ...(open.text ? { text: open.text } : {}),
        timestamp: open.first.timestamp,
        data: { kind: "text", stream: open.stream, chunks: open.chunks },
      });
      open = undefined;
    };

    for (const e of events) {
      if (e.type === "output" && e.data?.kind === "text") {
        const stream = String(e.data.stream ?? "output");
        if (open && open.stream === stream) {
          open.text += e.text ?? "";
          open.chunks += 1;
          continue;
        }
        flush();
        open = { first: e, stream, text: e.text ?? "", chunks: 1 };
        continue;
      }
      if (e.type !== "output" && e.type !== "waiting" && e.type !== "resumed") continue;
      flush();
      out.push({
        sequence: e.sequence,
        type: e.type,
        ...(e.text ? { text: e.text } : {}),
        timestamp: e.timestamp,
        ...(e.data ? { data: e.data } : {}),
      });
    }
    flush();
    return out.slice(-60);
  }

  /* ------------------------------- channels ---------------------------- */

  private channelState(id: string): ResolvedChannel {
    const declared = this.channelConfigs.find((c) => c.id === id);
    if (declared) {
      return {
        id,
        kind: "channel",
        title: `#${id}`,
        ...(declared.description ? { description: declared.description } : {}),
        members: (declared.members ?? this.members.map((m) => m.id))
          .map((mid) => this.member(mid))
          .filter((m): m is TeamMember => Boolean(m)),
      };
    }
    if (id.startsWith("dm:")) {
      const ids = this.dmParticipants(id);
      if (ids.length === 0) throw new Error(`no such team member in ${id}`);
      const names = ids.map((mid) => this.member(mid)?.name ?? mid);
      const dmMembers = ids.map((mid) => this.member(mid)).filter((m): m is TeamMember => Boolean(m));
      return {
        id,
        kind: "dm",
        title: ids.length > 1 ? `Group DM · ${names.join(", ")}` : `DM · ${names.join(", ")}`,
        members: dmMembers,
      };
    }
    throw new Error(
      `no such channel: ${id}. channels: ${this.channelConfigs.map((c) => c.id).join(", ")} (or dm:<member>)`,
    );
  }

  /**
   * Participants of a DM: whoever the id names, plus anyone who has already
   * spoken or been given a turn there. That is what makes an introduced
   * teammate a durable part of the thread instead of a one-off mention.
   */
  private dmParticipants(channelId: string): string[] {
    const fromId = channelId
      .split(":")
      .slice(1)
      .filter((part) => part && part !== "user" && this.member(part));
    const fromStore = this.store.channelParticipants(channelId).filter((id) => this.member(id));
    return [...new Set([...fromId, ...fromStore])];
  }

  /* ------------------------------ lifecycle ---------------------------- */

  /**
   * Stop accepting work, cancel what is in flight (its task is real and may be
   * writing files), and leave queued turns on disk for the next start. Running
   * turns are settled `failed` rather than replayed — the same reasoning as
   * crash recovery: a turn may already have had side effects.
   */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const turnId of this.running.values()) {
      const turn = this.store.getTurn(turnId);
      if (turn?.taskId) await this.orch.cancelTask(turn.taskId).catch(() => {});
    }
    for (let i = 0; i < 40 && this.running.size > 0; i++) await sleep(25);
    for (const turnId of this.running.values()) {
      try {
        this.store.patchTurn(turnId, {
          status: "failed",
          endedAt: Date.now(),
          error: "interrupted: the team process shut down",
        });
      } catch {
        // best effort — the store is about to close
      }
    }
    this.running.clear();
    this.store.close();
  }
}
