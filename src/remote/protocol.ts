/**
 * Wire protocol between a RemoteWorkerHandle (client, machine A) and a Worker
 * Daemon (server, machine B).
 *
 * Transport: a single authenticated WebSocket per active turn. Auth happens at
 * the HTTP upgrade via `Authorization: Bearer <token>` (see security.ts); the
 * token is read from an environment variable and never travels in config files.
 *
 * Design invariant (from PLAN §3/§7): ACP stdio NEVER crosses the network. The
 * daemon runs acpx/ACP locally on machine B; only this JSON control channel is
 * exposed, and only to authenticated callers over TLS (or loopback for dev).
 */

export const PROTOCOL_VERSION = 1;
export const WS_PATH = "/ws";
export const HEALTH_PATH = "/healthz";
export const PROFILES_PATH = "/profiles";

/** Reject absurd frames; task text/events are bounded well below this. */
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

/* ----------------------------- client → server ---------------------------- */

export interface SubmitMsg {
  type: "submit";
  /** client-chosen correlation id, echoed back in `submitted` */
  submitId: string;
  /** which daemon-side profile to run */
  profile: string;
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface ApproveMsg {
  type: "approve";
  approvalId: string;
  decision: string; // PermissionDecision
}

export interface RespondMsg {
  type: "respond";
  approvalId: string;
  action: string; // ElicitationAction
  content?: Record<string, unknown> | null;
}

export interface CancelMsg {
  type: "cancel";
  taskId: string;
}

/**
 * Ask the daemon for the authoritative persisted state of a task. Used to
 * reconcile after a dropped connection or a daemon restart: the master reads the
 * real TaskRecord instead of guessing (and never mistakes an unfinished task for
 * a success). Works for tasks submitted on any prior connection because the
 * daemon's Orchestrator persists to SQLite.
 */
export interface QueryMsg {
  type: "query";
  /** client-chosen correlation id, echoed back in `query_result` */
  queryId: string;
  taskId: string;
}

/**
 * Re-attach to a running (or finished) task and resume its event stream. The
 * daemon replays every persisted event with `sequence > afterSequence`, then
 * routes live events to this connection until the task reaches a terminal state.
 * This is the push-based complement to `query`: instead of polling for the final
 * record, a reconnecting master resumes the stream where it left off.
 */
export interface AttachMsg {
  type: "attach";
  /** client-chosen correlation id, echoed back in `attached` */
  attachId: string;
  taskId: string;
  /** replay events with sequence strictly greater than this (default 0 = all) */
  afterSequence?: number;
}

export interface PingMsg {
  type: "ping";
}

export type ClientMsg =
  | SubmitMsg
  | ApproveMsg
  | RespondMsg
  | CancelMsg
  | QueryMsg
  | AttachMsg
  | PingMsg;

/* ----------------------------- server → client ---------------------------- */

export interface SubmittedMsg {
  type: "submitted";
  submitId: string;
  taskId: string;
}

/**
 * A forwarded TaskEvent. The client reconstructs WorkerEvents from `output`
 * events (data.kind = original worker event type) and detects approval needs
 * from `waiting` events (data.approvalId / data.kind / data.title).
 */
export interface TaskEventMsg {
  type: "task_event";
  taskId: string;
  event: import("../types.js").TaskEvent;
}

export interface ResultMsg {
  type: "result";
  taskId: string;
  record: import("../types.js").TaskRecord;
}

/**
 * Reply to a `query`. `found` is false when the daemon has no such task (bad id,
 * or a store that predates it); otherwise `record` is the authoritative state.
 */
export interface QueryResultMsg {
  type: "query_result";
  queryId: string;
  found: boolean;
  record?: import("../types.js").TaskRecord;
}

/**
 * Acknowledges a successful `attach`. Sent before the replayed events so the
 * client knows the reattach took; `status` is the task's state at attach time and
 * `replayFrom` is the exclusive sequence boundary the replay starts after.
 */
export interface AttachedMsg {
  type: "attached";
  attachId: string;
  taskId: string;
  status: import("../types.js").TaskStatus;
  replayFrom: number;
}

export interface ErrorMsg {
  type: "error";
  submitId?: string;
  taskId?: string;
  message: string;
  code?: string;
}

export interface PongMsg {
  type: "pong";
}

export interface WelcomeMsg {
  type: "welcome";
  protocol: number;
  daemonId: string;
  profiles: string[];
}

export type ServerMsg =
  | WelcomeMsg
  | SubmittedMsg
  | TaskEventMsg
  | ResultMsg
  | QueryResultMsg
  | AttachedMsg
  | ErrorMsg
  | PongMsg;

/* --------------------------------- helpers -------------------------------- */

export function encode(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Minimal structural validation of an inbound client frame. */
export function parseClientMsg(raw: string): ClientMsg | undefined {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(v) || typeof v.type !== "string") return undefined;
  switch (v.type) {
    case "submit":
      if (typeof v.submitId !== "string" || typeof v.profile !== "string") return undefined;
      if (typeof v.prompt !== "string") return undefined;
      return v as unknown as SubmitMsg;
    case "approve":
      if (typeof v.approvalId !== "string" || typeof v.decision !== "string") return undefined;
      return v as unknown as ApproveMsg;
    case "respond":
      if (typeof v.approvalId !== "string" || typeof v.action !== "string") return undefined;
      return v as unknown as RespondMsg;
    case "cancel":
      if (typeof v.taskId !== "string") return undefined;
      return v as unknown as CancelMsg;
    case "query":
      if (typeof v.queryId !== "string" || typeof v.taskId !== "string") return undefined;
      return v as unknown as QueryMsg;
    case "attach":
      if (typeof v.attachId !== "string" || typeof v.taskId !== "string") return undefined;
      if (v.afterSequence !== undefined && typeof v.afterSequence !== "number") return undefined;
      return v as unknown as AttachMsg;
    case "ping":
      return { type: "ping" };
    default:
      return undefined;
  }
}
