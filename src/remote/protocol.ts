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

/** v2: `submit` may carry handoff artifacts (base64 + sha256);
 *  `submit.workerRef` / `submitted.workerRef` add per-conversation worker reuse,
 *  and `release` frees one; `submit.sessionKey` adds a conversation identity that
 *  outlives the daemon process. All additions are optional, so a peer that does
 *  not understand them degrades to "a fresh worker per task" instead of failing. */
export const PROTOCOL_VERSION = 2;

/** Oldest daemon a client may send `submit.artifacts` to. */
export const ARTIFACT_PROTOCOL_VERSION = 2;
export const WS_PATH = "/ws";
export const HEALTH_PATH = "/healthz";
export const PROFILES_PATH = "/profiles";

/** Reject absurd frames; task text/events are bounded well below this. */
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** One task never needs more than a handful of files alongside it. */
export const MAX_SUBMIT_ARTIFACTS = 8;

/* ----------------------------- client → server ---------------------------- */

/**
 * A handoff artifact travelling with a submit (cross-host diff handoff).
 *
 * `name` is a bare file name, never a path: the daemon chooses the directory,
 * so a master cannot ask it to write outside its own state dir. `data` is
 * base64 (JSON has no bytes) and `sha256` is the hex digest of the *raw* bytes,
 * checked before anything is written.
 */
export interface ArtifactMsg {
  name: string;
  data: string;
  sha256: string;
}

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
  /**
   * Files the task needs staged on the daemon host. The prompt refers to them as
   * `{{artifact:<index>}}`, which the daemon rewrites to the absolute staged
   * path before the task is submitted — so the master never has to guess a path
   * on a machine it cannot see.
   */
  artifacts?: ArtifactMsg[];
  /**
   * Reuse a live worker on the daemon host, so consecutive tasks share one ACP
   * session (and therefore one conversation). The value is opaque and issued by
   * the daemon in `submitted`; omit it to get a fresh worker. Treat it as a
   * capability: it is unguessable, and a daemon will refuse one it did not mint.
   */
  workerRef?: string;
  /**
   * Pin the task to a *stable* conversation key instead of a per-run handle.
   * Unlike `workerRef` it survives a daemon restart: when no live worker holds
   * the key, the daemon spawns one bound to it and the agent resumes the session
   * stored on disk under that name.
   *
   * Precedence: `workerRef` wins when both are sent. If the key is already held
   * by a live idle worker, that worker is reused; if it is busy, the submit is
   * refused (`session_busy`) rather than queueing behind an unknown amount of
   * work. Keys are plain strings, so they are *not* a capability — the daemon
   * only lets a client reach keys for profiles it is allowed to submit to.
   */
  sessionKey?: string;
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
 * Close a reused worker and free its session on the daemon. Optional and
 * best-effort: idle conversations are reaped anyway, this just stops paying for
 * an agent process the master already gave up on.
 */
export interface ReleaseMsg {
  type: "release";
  workerRef: string;
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
  | ReleaseMsg
  | PingMsg;

/* ----------------------------- server → client ---------------------------- */

export interface SubmittedMsg {
  type: "submitted";
  submitId: string;
  taskId: string;
  /**
   * Handle to the worker running this task. Pass it back on the next `submit` to
   * keep the same agent session; drop it (or `release` it) to start over. Absent
   * from a daemon that predates worker reuse.
   */
  workerRef?: string;
  /**
   * The conversation key the task is bound to, echoed so the client learns the
   * key even when it came from the daemon profile's `session` default. Absent
   * when the task runs in an ordinary, unkeyed worker.
   */
  sessionKey?: string;
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

/**
 * The daemon bound a task to a worker and minted a ref for it: the next `submit`
 * may pass `workerRef` to keep talking to the same agent session. Sent when the
 * task actually starts, because the worker is spawned by the scheduler then —
 * issuing the ref at submit time would require spawning ahead of the queue.
 */
export interface WorkerBoundMsg {
  type: "worker_bound";
  taskId: string;
  workerRef: string;
  /** The pinned conversation key this worker holds, when it was spawned with one. */
  sessionKey?: string;
}

/** Acknowledge a `release`. `ok` is false when the ref was already gone. */
export interface ReleasedMsg {
  type: "released";
  workerRef: string;
  ok: boolean;
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
  | PongMsg
  | ReleasedMsg
  | WorkerBoundMsg;

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
      if (v.artifacts !== undefined) {
        // Structural check only: size, name shape and checksum are enforced by
        // the daemon, which is the side that writes to disk.
        if (!Array.isArray(v.artifacts) || v.artifacts.length > MAX_SUBMIT_ARTIFACTS) {
          return undefined;
        }
        for (const a of v.artifacts) {
          if (
            !isRecord(a) ||
            typeof a.name !== "string" ||
            typeof a.data !== "string" ||
            typeof a.sha256 !== "string"
          ) {
            return undefined;
          }
        }
      }
      if (v.workerRef !== undefined && typeof v.workerRef !== "string") return undefined;
      if (v.sessionKey !== undefined && (typeof v.sessionKey !== "string" || v.sessionKey.length === 0)) {
        return undefined;
      }
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
    case "release":
      if (typeof v.workerRef !== "string") return undefined;
      return v as unknown as ReleaseMsg;
    case "ping":
      return { type: "ping" };
    default:
      return undefined;
  }
}
