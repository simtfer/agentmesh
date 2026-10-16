import path from "node:path";
import type {
  ElicitationResponse,
  MeshConfig,
  PermissionDecision,
  TaskEvent,
  TaskRecord,
  TaskStatus,
  TaskStore,
  TaskSubmitInput,
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
  cwd?: string;
  worktree?: boolean;
  timeoutMs?: number;
  /** live task-event stream (also persisted to the store) */
  onEvent?: (ev: TaskEvent) => void;
}

export interface DispatchResult {
  taskId: string;
  workerId?: string;
  profile: string;
  status: "completed" | "cancelled" | "failed";
  text: string;
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

  async spawnWorker(
    profileName: string,
    opts: { cwd?: string; worktree?: boolean } = {},
  ): Promise<string> {
    const profile = getProfile(this.config, profileName);
    const id = this.registry.nextId(profile.name);

    const useWorktree = opts.worktree ?? profile.worktree ?? false;
    let cwd = path.resolve(opts.cwd ?? profile.cwd ?? this.baseCwd);
    let worktree: WorkerRecord["worktree"];

    if (useWorktree) {
      const info = await createWorktree(this.baseCwd, id, this.workdir);
      worktree = info;
      cwd = info.path;
    }

    const driver = this.drivers.forProfile(profile);
    const handle = await driver.createWorker(profile, { id, cwd });

    this.registry.register({
      id,
      profileName: profile.name,
      profile,
      handle,
      status: "idle",
      cwd,
      worktree,
      createdAt: Date.now(),
      events: [],
    });
    this.registry.pushEvent(id, {
      t: Date.now(),
      type: "spawn",
      text: `${profile.name} @ ${cwd}`,
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
        cwd: input.cwd,
        worktree: input.worktree,
        timeoutMs: input.timeoutMs,
      },
      { onEvent: input.onEvent },
    );
    // dispatch is the synchronous convenience: keep waiting through any `waiting`
    // (approval) states until the task is terminal or the budget is exhausted.
    const deadline = Date.now() + (submitted.timeoutMs ?? 0) + 5000;
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
