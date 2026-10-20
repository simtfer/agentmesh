/**
 * A team is the social layer on top of workers: named members with their own
 * conversation, workspace and memory, and channels in which they talk to the
 * user and to each other.
 *
 * Configuration declares *who exists* (identity, harness profile, workspace);
 * the store records *what was said and done*. Runtime state — which turn is
 * running — is deliberately not configuration, so the same roster can be
 * restarted without losing the conversation.
 */

/** One member, as declared in `team.members` in agentmesh.yaml. */
export interface TeamMemberConfig {
  /** stable id, used for channel addresses, session keys and state paths */
  id: string;
  /** display name; defaults to the id */
  name?: string;
  /** what this member is for — shown to teammates, so keep it short */
  role?: string;
  /** harness profile that runs this member (must exist in `profiles`) */
  profile: string;
  /** handle used in messages, without the `@`; defaults to the id */
  mention?: string;
  /** working directory; defaults to `team.cwd` then the mesh base cwd */
  cwd?: string;
  /** standing instructions, prepended to every turn (keep it small) */
  notes?: string;
}

/**
 * A room. Members talk to the user and to each other here; `members` narrows
 * who is addressable, so a `#design` room can exclude the ops agent rather than
 * letting every mention reach every worker.
 */
export interface TeamChannelConfig {
  id: string;
  /** one line shown to members when they are in the room */
  description?: string;
  /** member ids; omitted = every member */
  members?: string[];
}

export interface TeamConfig {
  /** team name, used in prompts and to namespace session keys (default: "team") */
  name?: string;
  /** per-team state (sqlite + member homes); default `<workdir>/team` */
  stateDir?: string;
  /** default working directory for members without their own */
  cwd?: string;
  /** how many hand-offs a single message may travel (default 6) */
  maxHops?: number;
  /** how many turns one root message may cause in total (default 16) */
  maxTurnsPerMessage?: number;
  /** how many recent messages each turn sees (default 20) */
  contextMessages?: number;
  /** character cap on the rendered transcript (default 6000) */
  maxContextChars?: number;
  /** wall-clock budget for one member turn (default 15 minutes) */
  turnTimeoutMs?: number;
  /** bind address for `agentmesh team serve` (default 127.0.0.1) */
  host?: string;
  /** port for `agentmesh team serve` (default 4317) */
  port?: number;
  /** env var NAME holding the API bearer token; the value never lives in config */
  tokenEnv?: string;
  members: TeamMemberConfig[];
  channels?: TeamChannelConfig[];
}

/** A member with every path and key resolved. */
export interface TeamMember {
  id: string;
  name: string;
  role?: string;
  /** handle without `@`, matched case-insensitively */
  mention: string;
  profile: string;
  cwd: string;
  /**
   * Pinned conversation key. This is what makes a member an employee rather
   * than a function call: the same key resumes the same agent session, even
   * after the team process restarts.
   */
  sessionKey: string;
  /** file the member may append durable facts to; injected on every turn */
  memoryFile: string;
  notes?: string;
}

export type TeamMessageKind = "chat" | "system";

/**
 * One line in a channel. `author` is a member id, `"user"` for the human, or
 * `"system"` for machine notices (a failed turn, a cap being hit).
 */
export interface TeamMessage {
  /** monotonically increasing row id within this team store */
  seq: number;
  id: string;
  channel: string;
  author: string;
  authorName: string;
  kind: TeamMessageKind;
  text: string;
  /** member ids resolved from `@handles` at post time */
  mentions: string[];
  /** hand-off depth: 0 for the message a human posted */
  hops: number;
  /** the user message this thread started from */
  rootId: string;
  /** the message this one answers, when it was produced by a turn */
  replyTo?: string;
  /** the turn that produced it */
  turnId?: string;
  createdAt: number;
}

export type TeamTurnStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

/**
 * One member working on one message. A turn is the unit that maps onto an
 * agentmesh task; keeping it separate means the channel can show *who is
 * thinking* without exposing task internals to the conversation.
 */
export interface TeamTurn {
  seq: number;
  id: string;
  memberId: string;
  channel: string;
  /** the message being answered */
  messageId: string;
  /** the originating user message, for hop/turn accounting */
  rootId: string;
  /** distance from the root message (0 = the user addressed this member) */
  hops: number;
  taskId?: string;
  status: TeamTurnStatus;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  /** approval blocking a `waiting` turn */
  approvalId?: string;
  error?: string;
}

export interface TeamMemberState extends TeamMember {
  status: "idle" | "queued" | "running" | "waiting";
  queued: number;
  currentTurnId?: string;
  taskId?: string;
  workerId?: string;
  lastMessageAt?: number;
}

export interface TeamChannelState {
  id: string;
  kind: "channel" | "dm";
  title: string;
  description?: string;
  members: string[];
  lastMessageAt?: number;
  messageCount: number;
}

export interface TeamStatus {
  team: string;
  stateDir: string;
  members: TeamMemberState[];
  channels: TeamChannelState[];
  queued: number;
  running: number;
  waiting: number;
  maxHops: number;
  maxTurnsPerMessage: number;
}

/** A member's turn plus the task events behind it (the transparency view). */
export interface TeamTranscriptEntry extends TeamTurn {
  taskStatus?: string;
  /** busy marker so the CLI can tell "waiting for approval" from "failed" */
  events: Array<{
    sequence: number;
    type: string;
    text?: string;
    timestamp: string;
    data?: Record<string, unknown>;
  }>;
}
