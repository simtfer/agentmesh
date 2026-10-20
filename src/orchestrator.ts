import path from "node:path";
import type {
  ElicitationResponse,
  HandoffSpec,
  MeshConfig,
  PermissionDecision,
  RetryPolicy,
  TaskBudget,
  TaskEvent,
  TaskRecord,
  TaskStatus,
  TaskStore,
  TaskSubmitInput,
  TaskUsage,
  WorkerProfile,
} from "./types.js";
import { DEFAULT_MAX_DELEGATION_DEPTH, DELEGATION_DEPTH_ENV } from "./types.js";
import { getProfile } from "./config.js";
import { createDrivers, type DriverSet } from "./drivers/factory.js";
import { WorkerRegistry, describeWorker, type WorkerRecord } from "./registry.js";
import { createWorktree, removeWorktree } from "./worktree.js";
import { TaskManager, type WorkerProvider } from "./tasks.js";
import { ApprovalBroker } from "./approvals.js";
import { SqliteTaskStore } from "./store/sqlite.js";
import { MemoryTaskStore } from "./store/memory.js";

/** Parse the inherited delegation depth; anything absent/invalid/negative → 0. */
function readDelegationDepth(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

export interface OrchestratorOptions {
  baseCwd?: string;
  workdir?: string;
  /** inject a store (tests use MemoryTaskStore). Defaults to SQLite under workdir. */
  store?: TaskStore;
  /** set false to keep tasks in memory only (no SQLite file). */
  persist?: boolean;
  defaultTimeoutMs?: number;
}

export interface DispatchInput {
  task: string;
  workerId?: string;
  profile?: string;
  /** Pinned conversation key; ignored when `workerId` is given. */
  sessionKey?: string;
  cwd?: string;
  worktree?: boolean;
  timeoutMs?: number;
  /** End-to-end budget (ms) covering queue wait + execution. */
  deadlineMs?: number;
  /** Absolute epoch-ms deadline; earlier wins over `deadlineMs`. */
  deadlineAt?: number;
  /** Cross-worker handoff (Phase 1): inject a predecessor's result as untrusted context. */
  handoff?: HandoffSpec;
  /** Structured result contract: JSON Schema the final answer must satisfy. */
  outputSchema?: Record<string, unknown>;
  /** DAG dependencies: task IDs that must succeed before this task may start. */
  dependsOn?: string[];
  /** Automatic retry policy for this task. Omitted = settle on the first failure. */
  retry?: RetryPolicy;
  /** Spend ceiling for this task (tokens and/or cost), enforced while it runs. */
  budget?: TaskBudget;
  /** live task-event stream (also persisted to the store) */
  onEvent?: (ev: TaskEvent) => void;
}

export interface DispatchResult {
  taskId: string;
  workerId?: string;
  profile: string;
  status: "completed" | "cancelled" | "failed";
  text: string;
  /** parsed JSON result when an `outputSchema` contract was satisfied */
  structured?: unknown;
  /** token/cost roll-up reported by the worker, when it reports any */
  usage?: TaskUsage;
  stopReason?: string;
  cwd: string;
  worktree?: string;
  error?: { message: string; code?: string };
}

/**
 * The orchestration core. A master agent drives this through the MCP server;
 * the CLI and demo drive it directly. Owns worker lifecycle (ACP via acpx),
 * per-worker git worktree isolation, and the persistent 8-state task machine.
 */
export class Orchestrator {
  readonly config: MeshConfig;
  readonly baseCwd: string;
  readonly workdir: string;
  /** this process's inherited delegation depth (0 for a top-level master) */
  readonly delegationDepth: number;
  private drivers: DriverSet;
  private registry = new WorkerRegistry();
  private store: TaskStore;
  private approvals = new ApprovalBroker();
  private tasks: TaskManager;

  constructor(config: MeshConfig, opts: OrchestratorOptions = {}) {
    this.config = config;
    this.baseCwd = path.resolve(opts.baseCwd ?? config.defaults?.cwd ?? process.cwd());
    this.workdir = path.resolve(opts.workdir ?? config.workdir ?? ".agentmesh");
    // This process's own delegation depth, inherited from whoever spawned it. A
    // top-level master has no env set → 0. Any agentmesh we spawn inherits +1.
    this.delegationDepth = readDelegationDepth(process.env[DELEGATION_DEPTH_ENV]);
    this.drivers = createDrivers(config, this.baseCwd, this.delegationDepth);

    this.store =
      opts.store ??
      (opts.persist === false
        ? new MemoryTaskStore()
        : new SqliteTaskStore(path.join(this.workdir, "agentmesh.sqlite")));

    const provider: WorkerProvider = {
      spawnWorker: (profile, o) => this.spawnWorker(profile, o),
      getWorkerRecord: (id) => this.registry.get(id),
      cancelWorkerTurn: async (id) => {
        await this.registry.get(id)?.handle.cancel();
      },
    };

    this.tasks = new TaskManager({
      store: this.store,
      approvals: this.approvals,
      provider,
      defaultTimeoutMs: opts.defaultTimeoutMs,
      inferProfile: () => this.inferSingleProfile(),
      baseDelegationDepth: this.delegationDepth,
      maxDelegationDepth: config.limits?.maxDelegationDepth ?? DEFAULT_MAX_DELEGATION_DEPTH,
      maxConcurrentTasks: config.limits?.maxConcurrentTasks,
      maxOutputBytes: config.limits?.maxOutputBytes,
      maxQueuedTasks: config.limits?.maxQueuedTasks,
      queueTtlMs: config.limits?.queueTtlMs,
      // A profile's `weight` opts the queue into weighted fair scheduling; unknown
      // profiles (a task referencing a missing name) fall back to the neutral 1.
      profileWeight: (name) => {
        const w = this.config.profiles.find((p) => p.name === name)?.weight;
        return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : 1;
      },
      maxHandoffBytes: config.limits?.maxHandoffBytes,
      maxRetryAttempts: config.limits?.maxRetryAttempts,
      maxDependencies: config.limits?.maxDependencies,
      maxWaitingTasks: config.limits?.maxWaitingTasks,
      maxTotalTokens: config.limits?.maxTotalTokens,
      maxTotalCost: config.limits?.maxTotalCost,
      // Handoff artifacts (diff sidecars) live next to the rest of the per-repo
      // state, and snapshots are only usable when both tasks share this repo.
      workdir: this.workdir,
      baseRepo: this.baseCwd,
      profileWorktree: (name) =>
        this.config.profiles.find((p) => p.name === name)?.worktree ?? false,
      profileIsRemote: (name) =>
        this.config.profiles.find((p) => p.name === name)?.driver === "remote",
    });
  }

  /* ----------------------------- profiles ----------------------------- */

  listProfiles(): Array<Pick<WorkerProfile, "name" | "driver" | "agent" | "model" | "description">> {
    return this.config.profiles.map((p) => ({
      name: p.name,
      driver: p.driver,
      agent: p.agent,
      model: p.model,
      description: p.description,
    }));
  }

  /* ------------------------------ workers ----------------------------- */

  listWorkers(recentEvents = 0) {
    return this.registry.list().map((r) => describeWorker(r, recentEvents));
  }

  getWorker(id: string, recentEvents = 20) {
    const rec = this.registry.get(id);
    return rec ? describeWorker(rec, recentEvents) : undefined;
  }

  /** Raw worker record (not the described view) — used by the daemon to reuse
   *  a conversation's worker, where its cwd and profile must be exact. */
  getWorkerRecord(id: string) {
    return this.registry.get(id);
  }

  /** The live worker holding a pinned conversation, if any. A team asks this to
   *  report "this member has a running agent" between turns. */
  getWorkerBySessionKey(sessionKey: string) {
    return this.registry.bySessionKey(sessionKey);
  }

  /**
   * Close the worker that holds a conversation, freeing its agent process.
   * Refused (returns false) while that worker is mid-task: closing it would kill
   * work in flight, and the caller — a team rotating an old session — can simply
   * retry next turn. The stored session survives, so re-spawning the same key
   * later resumes the conversation.
   */
  async closeSession(sessionKey: string): Promise<boolean> {
    const rec = this.registry.bySessionKey(sessionKey);
    if (!rec) return false;
    if (this.tasks.isWorkerBusy(rec.id)) return false;
    await this.registry.remove(rec.id, `session ${sessionKey} retired`);
    return true;
  }

  async spawnWorker(
    profileName: string,
    opts: { cwd?: string; worktree?: boolean; baseCommit?: string; sessionKey?: string } = {},
  ): Promise<string> {
    const profile = getProfile(this.config, profileName);
    const id = this.registry.nextId(profile.name);

    const useWorktree = opts.worktree ?? profile.worktree ?? false;
    // A remote profile's cwd names a path on the *daemon's* host, so it must cross
    // the wire exactly as written. Resolving it here would apply this machine's
    // rules to a path it cannot see: a Windows master turns `/srv/repos` into
    // `D:\srv\repos` and the daemon then fails with "working directory not found".
    // Empty means "the daemon knows its own default" and is omitted on the wire.
    const remote = profile.driver === "remote";
    let cwd = remote
      ? (opts.cwd ?? profile.cwd ?? "")
      : path.resolve(opts.cwd ?? profile.cwd ?? this.baseCwd);
    let worktree: WorkerRecord["worktree"];

    // A pinned session is a promise about *where* the conversation lives: acpx
    // resumes a stored record only when sessionKey, agent, argv and cwd all
    // still match. A worktree gets a brand-new path on every spawn, so the two
    // would silently produce a fresh conversation every time — refuse instead
    // of pretending the session is stable.
    const sessionKey = opts.sessionKey ?? profile.session;
    if (sessionKey) {
      if (useWorktree) {
        throw new Error(
          `session "${sessionKey}" cannot be combined with worktree: every spawn gets a new ` +
            `worktree path, so the stored conversation would never match and would silently restart`,
        );
      }
      // Spawning under a key that a live worker already holds means "attach to
      // that conversation", not "start a second one on the same key": the ACP
      // layer would hand back the same stored session, and two tasks would then
      // interleave inside one transcript. Attach when it is free, refuse when it
      // is mid-turn — never queue, because the wait is unbounded and invisible.
      const holder = this.registry.bySessionKey(sessionKey);
      if (holder) {
        if (this.tasks.isWorkerBusy(holder.id)) {
          throw new Error(
            `session "${sessionKey}" is busy: worker ${holder.id} is still running a task; ` +
              `wait for it before the next turn`,
          );
        }
        this.registry.pushEvent(holder.id, {
          t: Date.now(),
          type: "status",
          text: `attached: session ${sessionKey}`,
        });
        return holder.id;
      }
    }

    if (useWorktree) {
      const info = await createWorktree(this.baseCwd, id, this.workdir, {
        fromCommit: opts.baseCommit,
      });
      worktree = info;
      cwd = info.path;
    }

    const driver = this.drivers.forProfile(profile);
    const handle = await driver.createWorker(profile, {
      id,
      cwd,
      ...(sessionKey ? { sessionKey } : {}),
    });

    this.registry.register({
      id,
      profileName: profile.name,
      profile,
      handle,
      status: "idle",
      cwd,
      worktree,
      sessionKey: handle.sessionKey ?? sessionKey,
      createdAt: Date.now(),
      events: [],
    });
    this.registry.pushEvent(id, {
      t: Date.now(),
      type: "spawn",
      text: `${profile.name} @ ${cwd || "the daemon's default cwd"}${
        sessionKey ? ` (session ${sessionKey})` : ""
      }`,
    });
    return id;
  }

  async killWorker(id: string): Promise<void> {
    const rec = this.registry.get(id);
    if (!rec) return;
    await this.registry.remove(id);
    if (rec.worktree) await removeWorktree(rec.worktree).catch(() => {});
  }

  /* ------------------------------- tasks ------------------------------ */

  submitTask(input: TaskSubmitInput, hooks?: { onEvent?: (ev: TaskEvent) => void }): TaskRecord {
    return this.tasks.submit(input, hooks);
  }

  taskStatus(taskId: string): TaskRecord | undefined {
    return this.tasks.status(taskId);
  }

  taskResult(taskId: string): TaskRecord | undefined {
    return this.tasks.result(taskId);
  }

  taskEvents(taskId: string, afterSequence = 0): TaskEvent[] {
    return this.tasks.events(taskId, afterSequence);
  }

  listTasks(filter?: { status?: TaskStatus; limit?: number }): TaskRecord[] {
    return this.tasks.listTasks(filter);
  }

  /**
   * Settle the tasks a previous process left running. Only a resident owner of
   * this workdir may call it — see `TaskManager.reconcile()` for why a short
   * command must not.
   */
  reconcile(): void {
    this.tasks.reconcile();
  }

  /** Scheduler introspection: running/queued counts, caps, and the FIFO order. */
  schedulerStatus() {
    return this.tasks.schedulerStats();
  }

  /** Token/cost roll-up across tasks, optionally narrowed by profile and start time. */
  usageSummary(filter?: { profile?: string; since?: number }) {
    return this.tasks.usageSummary(filter);
  }

  waitTask(taskId: string, timeoutMs?: number): Promise<TaskRecord | undefined> {
    return this.tasks.wait(taskId, timeoutMs);
  }

  cancelTask(taskId: string): Promise<TaskRecord | undefined> {
    return this.tasks.cancel(taskId);
  }

  pendingApprovals(taskId?: string) {
    return this.tasks.pendingApprovals(taskId);
  }

  approveTask(approvalId: string, decision: PermissionDecision): boolean {
    return this.tasks.approve(approvalId, decision);
  }

  respondTask(approvalId: string, response: ElicitationResponse): boolean {
    return this.tasks.respond(approvalId, response);
  }

  /** Convenience: submit + wait, mapped to the original synchronous shape. */
  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const submitted = this.tasks.submit(
      {
        prompt: input.task,
        profile: input.profile,
        workerId: input.workerId,
        sessionKey: input.sessionKey,
        cwd: input.cwd,
        worktree: input.worktree,
        timeoutMs: input.timeoutMs,
        deadlineMs: input.deadlineMs,
        deadlineAt: input.deadlineAt,
        handoff: input.handoff,
        outputSchema: input.outputSchema,
        dependsOn: input.dependsOn,
        retry: input.retry,
        budget: input.budget,
      },
      { onEvent: input.onEvent },
    );
    // dispatch is the synchronous convenience: keep waiting through any `waiting`
    // (approval) states until the task is terminal or the budget is exhausted.
    const deadline = Math.min(Date.now() + (submitted.timeoutMs ?? 0) + 5000, submitted.deadlineAt ?? Number.POSITIVE_INFINITY);
    let rec = await this.tasks.wait(submitted.taskId, Math.max(0, deadline - Date.now()));
    while (rec && rec.status === "waiting" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      rec = await this.tasks.wait(submitted.taskId, Math.max(0, deadline - Date.now()));
    }
    const wrec = rec?.workerId ? this.registry.get(rec.workerId) : undefined;
    const status: DispatchResult["status"] =
      rec?.status === "succeeded" ? "completed" : rec?.status === "cancelled" ? "cancelled" : "failed";
    return {
      taskId: submitted.taskId,
      workerId: rec?.workerId,
      profile: rec?.profile ?? submitted.profile,
      status,
      text: rec?.text ?? "",
      stopReason: rec?.stopReason,
      ...(rec?.structured !== undefined ? { structured: rec.structured } : {}),
      ...(rec?.usage ? { usage: rec.usage } : {}),
      cwd: wrec?.cwd ?? input.cwd ?? this.baseCwd,
      worktree: wrec?.worktree?.path,
      error:
        rec?.error ??
        (rec?.status === "timed_out" ? { message: "task timed out", code: "timed_out" } : undefined),
    };
  }

  /* ----------------------------- lifecycle ---------------------------- */

  async shutdown(): Promise<void> {
    await this.tasks.shutdown().catch(() => {});
    for (const rec of this.registry.list()) {
      if (rec.worktree) await removeWorktree(rec.worktree).catch(() => {});
    }
    await this.registry.closeAll();
    await this.drivers.dispose();
    this.store.close();
  }

  private inferSingleProfile(): string {
    if (this.config.profiles.length === 1) return this.config.profiles[0]!.name;
    throw new Error(
      "task needs a `profile` or `workerId` when multiple profiles are configured",
    );
  }
}

export async function createOrchestrator(
  config: MeshConfig,
  opts: OrchestratorOptions = {},
): Promise<Orchestrator> {
  return new Orchestrator(config, opts);
}
