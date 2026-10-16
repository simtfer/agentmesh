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

export interface WorkerProfile {
  /** unique profile name referenced by config and MCP tools */
  name: string;
  driver: "acpx" | "mock";
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
  description?: string;
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
}

export interface WorkerDriver {
  readonly kind: "acpx" | "mock";
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
