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
  | "usage"
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
  /**
   * Fail this profile's first N turns *across workers* (a deterministic stand-in
   * for a transient upstream failure), then behave normally. Unlike `failOn` it
   * does not depend on the prompt, so a retried attempt sees different behaviour
   * without the test having to change the text.
   */
  failFirst?: number;
  /** simulate N tool calls before replying */
  toolCalls?: number;
  /** if true, ask for permission before replying (drives the `waiting` state) */
  requireApproval?: boolean;
  /**
   * Files to write (relative to the worker's cwd) before the turn completes.
   * Lets tests and demos exercise handoff `inject: "diff"` / `base: "predecessor"`
   * without a real agent that edits files.
   */
  writeFiles?: Record<string, string>;
  /**
   * Deterministic usage reports for token/cost roll-up tests. Each of `reports`
   * events carries the running total (report i = i × the configured value), so a
   * correct "latest report wins" roll-up is distinguishable from a naive sum.
   */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    thoughtTokens?: number;
    totalTokens?: number;
    cost?: { amount: number; currency?: string };
    contextUsed?: number;
    contextSize?: number;
    reports?: number;
  };
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
  /**
   * Scheduler weight for this profile's queued tasks (default 1). All weights at
   * 1 keep the classic strict-FIFO queue; any other weight opts the scheduler
   * into weighted fair queueing, where a profile with weight 3 gets roughly three
   * times as many dispatch slots as a weight-1 profile under contention.
   */
  weight?: number;
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
  /**
   * Rotate the audit log once it reaches this many bytes (default 10 MiB).
   * Set `0` to disable rotation and let the operator handle it externally.
   */
  auditMaxBytes?: number;
  /** How many rotated archives to keep (default 5). `0` disables rotation. */
  auditKeep?: number;
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
    /**
     * Scheduler queue bound (Stage 5). How many tasks may *wait* in the FIFO
     * queue for a free `maxConcurrentTasks` slot. 0/omitted = no queue, so a
     * submit over the concurrency cap is refused immediately (fail-fast). >0 =
     * real scheduling: over-cap submits stay `queued` and start FIFO as running
     * tasks settle; only a full queue refuses (`queue_full`).
     */
    maxQueuedTasks?: number;
    /**
     * Queue TTL: how long a task may sit *queued* before it expires and settles
     * `timed_out` (error `queue_ttl_exceeded`) without ever spawning a worker.
     * 0/omitted = no TTL. `maxQueuedTasks` bounds *how many* wait; this bounds
     * *how long* one may wait, so a deep backlog cannot strand work forever.
     */
    queueTtlMs?: number;
    /**
     * Cross-worker handoff (Phase 1). Cap on the upstream artifact bytes injected
     * into a successor task's prompt. Larger artifacts are truncated on a UTF-8
     * boundary and flagged in the task's `handoff` metadata. Default 256 KiB.
     */
    maxHandoffBytes?: number;
    /**
     * Upper bound on a task's total attempts (`retry.maxAttempts`), so a caller
     * cannot ask for an unbounded retry loop. Default 5.
     */
    maxRetryAttempts?: number;
    /**
     * Max `dependsOn` entries per task. Bounds the fan-in of one DAG node (and
     * the size of the dependency index). Default 16.
     */
    maxDependencies?: number;
    /**
     * How many tasks may sit in `waiting` (blocked on an approval/elicitation)
     * at once. 0/omitted = unlimited.
     *
     * A fan-out can otherwise park the whole batch on questions the master has
     * not answered yet: every one holds a concurrency slot and produces one more
     * entry in `pending_approvals`, and the master's attention is the resource
     * that actually runs out. Past the cap, further permission requests are
     * refused immediately (denied) instead of parking, and the worker carries on
     * without that tool rather than the batch stalling silently.
     */
    maxWaitingTasks?: number;
    /**
     * Total tokens this process may spend across every task. Once the running
     * roll-up crosses it, new submits are refused (`budget_exhausted`); work
     * already accepted is left alone, because cancelling it would not un-spend
     * the money. 0/omitted = unlimited.
     */
    maxTotalTokens?: number;
    /**
     * Same idea as `maxTotalTokens`, in money. Costs are accumulated per
     * currency and compared against the matching one only.
     */
    maxTotalCost?: { amount: number; currency?: string };
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

/** Default cap on injected handoff artifact bytes when `limits.maxHandoffBytes` is unset. */
export const DEFAULT_MAX_HANDOFF_BYTES = 256 * 1024;

/** Default cap on total task attempts when `retry.maxAttempts` exceeds `limits.maxRetryAttempts`. */
export const DEFAULT_MAX_RETRY_ATTEMPTS = 5;

/** Default cap on `dependsOn` entries per task. */
export const DEFAULT_MAX_DEPENDENCIES = 16;

/**
 * Cross-worker handoff spec (Phase 1). Injects a predecessor task's output into
 * this task's prompt as *untrusted context* — the successor reads it but does not
 * continue on the predecessor's git branch. Phase 1 supports a single artifact
 * (`result`, the predecessor's final text) and a single base (`repo`, a fresh
 * worktree); `diff`/`predecessor` are reserved for later phases.
 */
export interface HandoffSpec {
  /** The task whose output is handed off. Must be terminal and `succeeded`. */
  fromTaskId: string;
  /**
   * What to inject into the successor.
   * - `"result"` (Phase 1): the predecessor's final result text, inline in the prompt.
   * - `"diff"` (Phase 2): the predecessor's working-tree diff, redacted and written
   *   to a sidecar file under `workdir/handoffs/`. The prompt only references the
   *   path, so a large patch never has to fit in a prompt.
   */
  inject?: "result" | "diff";
  /**
   * Where the successor runs.
   * - `"repo"` (Phase 1): a normal worker — its worktree branches from the repo's
   *   current HEAD, and the predecessor's output is injected as context.
   * - `"predecessor"` (Phase 3): its worktree branches from a snapshot of the
   *   predecessor's *end state* (including uncommitted edits and untracked files),
   *   so the successor literally starts where the predecessor stopped.
   *   Requires the successor to run in a worktree.
   */
  base?: "repo" | "predecessor";
  /** Per-task override of `limits.maxHandoffBytes`. */
  maxBytes?: number;
}

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
  | "queued"
  | "dependency"
  | "started"
  | "retry"
  | "handoff"
  | "output"
  | "waiting"
  | "resumed"
  | "budget"
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

/**
 * Token/cost accounting for one task, rolled up from the worker's usage reports.
 *
 * Every field is optional and an absent field means "the agent never told us",
 * not zero — adapters differ in what they report. Token counts are the latest
 * report for the task (ACP reports per-turn totals, so summing every update
 * would double count). `cost` is the *delta* of the worker's cumulative session
 * cost across the task, so reusing a worker never bills an earlier task twice.
 */
export interface TaskUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
  cost?: { amount: number; currency?: string };
  /** Context-window occupancy at the last report — not a token spend. */
  contextUsed?: number;
  contextSize?: number;
  /** How many usage reports the worker sent; absent/0 = it reported nothing. */
  reports?: number;
}

/**
 * Spend ceiling for a single task, enforced while it runs.
 *
 * A wall-clock budget already bounds *time*; this bounds *money*. The two are
 * independent: an agent can finish in two seconds and still burn a fortune in
 * tokens, which is exactly the fan-out failure mode a deadline does not catch.
 *
 * Checked on every usage report, so a breach stops the turn mid-flight instead
 * of surfacing after the fact in `usage_summary`. Both ceilings count the whole
 * task across all attempts — a retry does not get a fresh allowance, because the
 * money it already spent is gone either way.
 */
export interface TaskBudget {
  /** Max tokens (total, or input+output when the adapter reports no total). */
  maxTokens?: number;
  /**
   * Max cost. Compared only against reports in the same currency, so a task
   * cannot be failed by a currency switch it did not cause.
   */
  maxCost?: { amount: number; currency?: string };
}

/**
 * Automatic retry policy for a task (Stage 5 advanced scheduling).
 *
 * Retries are opt-in: with no policy a task settles on its first failure, exactly
 * as before. When present, a failed/timed-out attempt that actually started is
 * re-queued instead of settling, up to `maxAttempts` runs in total. Admission
 * refusals (queue full, depth exceeded, bad handoff, …) are never retried: they
 * never reached a worker, so replaying them would fail identically.
 */
export interface RetryPolicy {
  /** Total attempts including the first. 1 = no retry. Capped by `limits.maxRetryAttempts`. */
  maxAttempts?: number;
  /** Base delay before re-queueing, in ms. Default 0 (immediate). */
  delayMs?: number;
  /** `fixed` (default) or `exponential` (delayMs × 2^(attempt-1)). */
  backoff?: "fixed" | "exponential";
  /** Cap on any single delay, in ms. Default 300000 (5 min). */
  maxDelayMs?: number;
  /**
   * Retry only when the failure is marked retryable (contract violations are,
   * most worker errors are not). Default false = retry any failure that ran.
   */
  onlyRetryable?: boolean;
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
  /**
   * Absolute epoch-ms deadline for the whole task (queue wait + execution).
   * Absent = no deadline. Reaching it settles the task `timed_out` with error
   * `deadline_exceeded`, whether it was still queued or already running.
   */
  deadlineAt?: number;
  /**
   * Dependencies (Stage 5 DAG). The task is accepted but will not compete for a
   * scheduler slot until every listed task has settled `succeeded`; a dependency
   * that settles any other way fails this task with `dependency_failed`.
   */
  dependsOn?: string[];
  /** Dependencies still outstanding. Empty/absent → the task is ready. */
  blockedBy?: string[];
  /** 1-based attempt counter; absent means the first (and only) attempt. */
  attempt?: number;
  /** Total attempts allowed by the task's retry policy; absent = 1. */
  maxAttempts?: number;
  /** Epoch ms before which a retry must not start (backoff delay). */
  retryAt?: number;
  /**
   * Spend ceiling for this task. Reaching it aborts the turn and settles the task
   * `failed` (`budget_exceeded`); the attempt is never retried, since replaying
   * it would spend again. Absent = only the wall-clock limits apply.
   */
  budget?: TaskBudget;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** final assistant text (may be truncated by output limits) */
  text?: string;
  /**
   * Parsed JSON result when the task ran under an `outputSchema` contract and
   * satisfied it. Absent means "no contract" or "contract not satisfied" — the
   * latter always fails the task, so a `succeeded` task with a contract always
   * carries this.
   */
  structured?: unknown;
  /** token/cost roll-up reported by the worker during this task */
  usage?: TaskUsage;
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
  /**
   * Budget in ms from submit that must cover queue wait *and* execution. When it
   * runs out the task settles `timed_out` (`deadline_exceeded`) — or never starts
   * at all if it is still queued.
   */
  deadlineMs?: number;
  /** Absolute epoch-ms deadline; the earlier of this and `deadlineMs` wins. */
  deadlineAt?: number;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  /**
   * DAG dependencies: task IDs that must settle `succeeded` before this task is
   * allowed to start. Requires a queue (`limits.maxQueuedTasks > 0`), since a
   * blocked task is accepted work waiting for a scheduler slot.
   */
  dependsOn?: string[];
  /** Automatic retry policy. Omitted = fail once, settle immediately. */
  retry?: RetryPolicy;
  /**
   * Spend ceiling for this task (tokens and/or cost). Enforced on every usage
   * report: a breach aborts the turn and settles `failed` (`budget_exceeded`),
   * counting every attempt, never retried.
   */
  budget?: TaskBudget;
  /** Cross-worker handoff (Phase 1): inject a predecessor's result as untrusted context. */
  handoff?: HandoffSpec;
  /**
   * Structured result contract: a JSON Schema (draft-07 keywords) the task's
   * final answer must satisfy. Enforced — a reply that is not parseable JSON or
   * does not validate settles the task `failed` (`output_not_json` /
   * `output_schema_invalid`) with the offending text still persisted. The schema
   * is never stored on the task; the parsed value is (`structured`).
   */
  outputSchema?: Record<string, unknown>;
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
