/**
 * Core domain types for agentmesh.
 *
 * Design note: a "role" (master vs worker) is NOT baked into an agent type.
 * The master is whichever agent has the agentmesh MCP server attached; workers
 * are whatever the adapter drives over ACP. The same opencode/pi binary can be
 * either, decided purely by config + how it is launched.
 */

export type WorkerStatus = "starting" | "idle" | "busy" | "closed" | "error";

export type WorkerEventType =
  | "spawn"
  | "text"
  | "tool"
  | "status"
  | "error"
  | "done"
  | "close";

export interface WorkerEvent {
  /** epoch ms */
  t: number;
  type: WorkerEventType;
  text?: string;
  /** free-form structured detail (tool kind, stop reason, error code, ...) */
  data?: Record<string, unknown>;
}

export interface TurnResult {
  status: "completed" | "cancelled" | "failed";
  /** concatenated assistant output text for the turn */
  text: string;
  stopReason?: string;
  error?: { message: string; code?: string };
  /** events captured during the turn */
  events: WorkerEvent[];
}

/** Generic permission/elicitation hooks (driver-agnostic). */
export type PermissionDecision =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always"
  | "cancel";

export interface PermissionRequest {
  id: string;
  toolKind?: string;
  title?: string;
  raw?: unknown;
}

export type PermissionHandler = (req: PermissionRequest) => Promise<PermissionDecision>;

export type ElicitationAction = "accept" | "decline" | "cancel";

export interface ElicitationRequest {
  id: string;
  raw?: unknown;
}

export interface ElicitationResponse {
  action: ElicitationAction;
  content?: Record<string, unknown> | null;
}

export type ElicitationHandler = (req: ElicitationRequest) => Promise<ElicitationResponse>;

export interface RunTurnOptions {
  onEvent?: (e: WorkerEvent) => void;
  signal?: AbortSignal;
  /** Called when the agent asks to run a risky tool; blocks until decided. */
  onPermissionRequest?: PermissionHandler;
  /** Called when the agent asks the user for input; blocks until answered. */
  onElicitation?: ElicitationHandler;
}

/** A live, addressable worker the orchestrator can send turns to. */
export interface WorkerHandle {
  readonly id: string;
  readonly profile: string;
  readonly cwd: string;
  /** Run one prompt turn to completion, collecting streamed output. */
  runTurn(text: string, opts?: RunTurnOptions): Promise<TurnResult>;
  /** Cancel the currently running turn (worker stays alive). */
  cancel(): Promise<void>;
  /** Close the worker/session and release resources. */
  close(reason?: string): Promise<void>;
}

/** Mock-only knobs; ignored by the acpx driver. */
export interface MockBehavior {
  /** canned reply, or a template function of the task text */
  reply?: string;
  delayMs?: number;
  /** if the task contains this substring, the turn fails (for testing) */
  failOn?: string;
  /** simulate N tool calls before replying */
  toolCalls?: number;
  /** if true, ask for permission before replying (drives the `waiting` state) */
  requireApproval?: boolean;
}

/** Settings for a `driver: "remote"` profile (a worker that lives on a daemon). */
export interface RemoteSettings {
  /** Daemon base URL: https://host:port (TLS) or http://host:port (loopback dev). */
  endpoint: string;
  /**
   * Name of the environment variable holding the bearer token. The token VALUE
   * is read from process.env at runtime and is never stored in config/VCS.
   */
  tokenEnv?: string;
  /** Which profile on the daemon to run (defaults to this profile's name). */
  remoteProfile?: string;
  /** Optional PEM CA bundle to trust a self-signed daemon cert. */
  ca?: string;
  /** Optional client certificate/key for mTLS (paths or PEM). */
  cert?: string;
  key?: string;
  /** Connect/handshake timeout in ms (default 15000). */
  connectTimeoutMs?: number;
  /**
   * Transparently re-attach if the turn socket drops mid-run instead of failing.
   * Requires the daemon to run with an `orphanGraceMs` window so the task stays
   * alive across the reconnect. Default false.
   */
  resume?: boolean;
  /** Max reconnect attempts when `resume` is on (default 3). */
  reconnectAttempts?: number;
  /** Delay before each reconnect attempt in ms (default 500). */
  reconnectDelayMs?: number;
}

export interface WorkerProfile {
  /** unique profile name referenced by config and MCP tools */
  name: string;
  driver: "acpx" | "mock" | "remote";
  /** acpx built-in agent name (pi, opencode, codex, ...) or a custom key */
  agent?: string;
  /** custom ACP launch command override (string or argv array) */
  command?: string | string[];
  model?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** acpx permission mode: deny-all | approve-reads | approve-all */
  permissionMode?: string;
  /** run each spawn in an isolated git worktree of the base repo */
  worktree?: boolean;
  mock?: MockBehavior;
  /** present when driver === "remote" */
  remote?: RemoteSettings;
  description?: string;
}

/** Daemon-side settings (only meaningful for the host running `agentmesh daemon`). */
export interface DaemonSettings {
  host?: string;
  port?: number;
  /** env var name holding the bearer token clients must present */
  tokenEnv?: string;
  /** working directories a remote task's cwd is allowed to be within */
  allowCwd?: string[];
  tls?: { cert?: string; key?: string; ca?: string };
  /** advertise only these profiles remotely (default: all non-remote profiles) */
  exposeProfiles?: string[];
  /**
   * Grace window (ms) to keep an orphaned, still-running task alive after its
   * socket drops so a client can `attach` and resume it. Default 0 = cancel
   * immediately (no orphans).
   */
  orphanGraceMs?: number;
  /**
   * Path to an append-only NDJSON audit log of security-relevant control-plane
   * events (auth decisions, submits, approvals, cancels, reloads). Secrets are
   * never written — only a redacted fingerprint. Defaults to
   * `<workdir>/daemon-audit.ndjson`; set empty string to disable.
   */
  auditPath?: string;
}

export interface MeshConfig {
  profiles: WorkerProfile[];
  defaults?: {
    cwd?: string;
    permissionMode?: string;
    stateDir?: string;
  };
  /** where git worktrees / session state live (default: ./.agentmesh) */
  workdir?: string;
  daemon?: DaemonSettings;
  /**
   * Resource & recursion limits (PLAN §7). A master is itself an agent, so
   * without a cap a delegation chain (or a master↔worker loop) can recurse
   * forever. `maxDelegationDepth` bounds how deep this process will accept;
   * the depth is propagated to spawned agents via `DELEGATION_DEPTH_ENV` so any
   * nested agentmesh inherits parentDepth + 1.
   */
  limits?: {
    /** max accepted delegation depth; a submit at depth >= this is refused. Default 8. */
    maxDelegationDepth?: number;
    /**
     * Max non-terminal tasks in flight at once; a submit beyond the cap is
     * refused (code `concurrency_limit_exceeded`) without spawning a worker.
     * 0/undefined = unlimited.
     */
    maxConcurrentTasks?: number;
    /**
     * Cap on the result text persisted per task (bytes). Larger results are
     * truncated and the record is flagged `outputTruncated`. Default 1 MiB.
     */
    maxOutputBytes?: number;
  };
}

/**
 * Environment variable carrying this process's delegation depth. An agentmesh
 * reads it as its base depth and injects base+1 into every agent it spawns, so
 * a nested agentmesh (mounted as the agent's MCP server) inherits the chain
 * depth across process boundaries. Absent/invalid → 0 (top-level master).
 */
export const DELEGATION_DEPTH_ENV = "AGENTMESH_DELEGATION_DEPTH";

/** Default cap on delegation depth when `limits.maxDelegationDepth` is unset. */
export const DEFAULT_MAX_DELEGATION_DEPTH = 8;

export interface WorkerDriver {
  readonly kind: "acpx" | "mock" | "remote";
  createWorker(
    profile: WorkerProfile,
    opts: { id: string; cwd: string },
  ): Promise<WorkerHandle>;
  dispose?(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Task layer (v1.1): 8-state machine + persistence                     */
/* ------------------------------------------------------------------ */

export type AgentKind = "opencode" | "pi" | "mock" | "other";

export type TaskStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

export type TaskEventType =
  | "accepted"
  | "started"
  | "output"
  | "waiting"
  | "resumed"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface TaskEvent {
  eventId: string;
  taskId: string;
  workerId?: string;
  sequence: number;
  timestamp: string;
  type: TaskEventType;
  text?: string;
  data?: Record<string, unknown>;
}

export interface TaskRecord {
  taskId: string;
  profile: string;
  workerId?: string;
  prompt: string;
  workingDirectory: string;
  status: TaskStatus;
  sessionId?: string;
  idempotencyKey?: string;
  timeoutMs: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** final assistant text (may be truncated by output limits) */
  text?: string;
  /** true when `text` was clipped by `limits.maxOutputBytes` */
  outputTruncated?: boolean;
  stopReason?: string;
  waitingReason?: string;
  error?: { code: string; message: string; retryable: boolean };
  metadata?: Record<string, unknown>;
}

export interface TaskSubmitInput {
  prompt: string;
  profile?: string;
  workerId?: string;
  cwd?: string;
  worktree?: boolean;
  timeoutMs?: number;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

/** Persistence for tasks + events. Implementations: memory (tests) and SQLite. */
export interface TaskStore {
  createTask(rec: TaskRecord): void;
  updateTask(taskId: string, patch: Partial<TaskRecord>): TaskRecord | undefined;
  getTask(taskId: string): TaskRecord | undefined;
  listTasks(filter?: { status?: TaskStatus; limit?: number }): TaskRecord[];
  findByIdempotencyKey(key: string): TaskRecord | undefined;
  appendEvent(taskId: string, ev: Omit<TaskEvent, "sequence">): TaskEvent;
  listEvents(taskId: string, afterSequence?: number): TaskEvent[];
  close(): void;
}
