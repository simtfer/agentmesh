import { randomUUID } from "node:crypto";
import type {
  ElicitationRequest,
  ElicitationResponse,
  PermissionDecision,
  PermissionRequest,
  TaskEvent,
  TaskRecord,
  TaskStatus,
  TaskStore,
  TaskSubmitInput,
  WorkerEvent,
} from "./types.js";
import { isTerminal, canTransition } from "./statemachine.js";
import type { ApprovalBroker } from "./approvals.js";
import type { WorkerRecord } from "./registry.js";

export interface WorkerProvider {
  spawnWorker(profile: string, opts?: { cwd?: string; worktree?: boolean }): Promise<string>;
  getWorkerRecord(workerId: string): WorkerRecord | undefined;
  cancelWorkerTurn(workerId: string): Promise<void>;
}

interface LiveTask {
  controller: AbortController;
  workerId?: string;
  timer?: NodeJS.Timeout;
  abortReason?: "timeout" | "cancel";
  done: Promise<TaskRecord>;
  resolveDone: (r: TaskRecord) => void;
  /** Resolves each time the task newly enters `waiting`; re-armed on resume. */
  waiting: Promise<TaskRecord>;
  resolveWaiting: (r: TaskRecord) => void;
  onEvent?: (ev: TaskEvent) => void;
}

export interface TaskManagerOptions {
  store: TaskStore;
  approvals: ApprovalBroker;
  provider: WorkerProvider;
  defaultTimeoutMs?: number;
  inferProfile: () => string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class TaskManager {
  private live = new Map<string, LiveTask>();
  private store: TaskStore;
  private approvals: ApprovalBroker;
  private provider: WorkerProvider;
  private defaultTimeoutMs: number;
  private inferProfile: () => string;

  constructor(opts: TaskManagerOptions) {
    this.store = opts.store;
    this.approvals = opts.approvals;
    this.provider = opts.provider;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.inferProfile = opts.inferProfile;
  }

  /* ------------------------------ submit ------------------------------ */

  submit(
    input: TaskSubmitInput,
    hooks?: { onEvent?: (ev: TaskEvent) => void },
  ): TaskRecord {
    if (!input.prompt || !input.prompt.trim()) throw new Error("task prompt is required");

    if (input.idempotencyKey) {
      const existing = this.store.findByIdempotencyKey(input.idempotencyKey);
      if (existing) return existing; // de-duplicate replayed submits
    }

    let profile = input.profile;
    if (!profile && input.workerId) {
      profile = this.provider.getWorkerRecord(input.workerId)?.profileName;
    }
    if (!profile) profile = this.inferProfile();

    const workerRec = input.workerId ? this.provider.getWorkerRecord(input.workerId) : undefined;
    const cwd = input.cwd ?? workerRec?.cwd ?? process.cwd();

    const now = Date.now();
    const taskId = randomUUID();
    const rec: TaskRecord = {
      taskId,
      profile,
      prompt: input.prompt,
      workingDirectory: cwd,
      status: "queued",
      timeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
      createdAt: now,
      updatedAt: now,
      workerId: input.workerId,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata,
    };
    this.store.createTask(rec);

    let resolveDone!: (r: TaskRecord) => void;
    const done = new Promise<TaskRecord>((r) => (resolveDone = r));
    let resolveWaiting!: (r: TaskRecord) => void;
    const waiting = new Promise<TaskRecord>((r) => (resolveWaiting = r));
    this.live.set(taskId, {
      controller: new AbortController(),
      done,
      resolveDone,
      waiting,
      resolveWaiting,
      onEvent: hooks?.onEvent,
    });

    this.append(taskId, "accepted", `task accepted for profile ${profile}`);

    // fire and forget; errors are captured into the task record
    void this.run(taskId, input).catch((err) => {
      this.append(taskId, "failed", err instanceof Error ? err.message : String(err));
    });

    return this.store.getTask(taskId)!;
  }

  /* ------------------------------- run -------------------------------- */

  private async run(taskId: string, input: TaskSubmitInput): Promise<void> {
    const live = this.live.get(taskId);
    if (!live) return;
    try {
      this.setState(taskId, "starting");

      let workerId = input.workerId;
      if (!workerId) {
        workerId = await this.provider.spawnWorker(input.profile ?? this.taskProfile(taskId), {
          cwd: input.cwd,
          worktree: input.worktree,
        });
      }
      live.workerId = workerId;
      const wrec = this.provider.getWorkerRecord(workerId);
      if (!wrec) throw new Error(`worker disappeared: ${workerId}`);
      this.store.updateTask(taskId, { workerId, sessionId: workerId });

      live.timer = setTimeout(() => this.onTimeout(taskId), this.taskTimeout(taskId));
      this.setState(taskId, "running", { startedAt: Date.now() });

      const turn = await wrec.handle.runTurn(this.store.getTask(taskId)!.prompt, {
        signal: live.controller.signal,
        onEvent: (ev) => this.onWorkerEvent(taskId, workerId!, ev),
        onPermissionRequest: (req) => this.onPermission(taskId, req),
        onElicitation: (req) => this.onElicitation(taskId, req),
      });

      if (live.timer) clearTimeout(live.timer);

      if (live.abortReason === "timeout") {
        this.setState(taskId, "timed_out", { finishedAt: Date.now() });
      } else if (live.abortReason === "cancel") {
        this.setState(taskId, "cancelled", { finishedAt: Date.now() });
      } else if (turn.status === "completed") {
        this.setState(taskId, "succeeded", {
          text: turn.text,
          stopReason: turn.stopReason,
          finishedAt: Date.now(),
        });
      } else if (turn.status === "cancelled") {
        this.setState(taskId, "cancelled", { finishedAt: Date.now() });
      } else {
        this.setState(taskId, "failed", {
          finishedAt: Date.now(),
          error: {
            code: turn.error?.code ?? "agent_failed",
            message: turn.error?.message ?? "worker turn failed",
            retryable: false,
          },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cur = this.store.getTask(taskId);
      const status: TaskStatus = live.abortReason === "timeout" ? "timed_out"
        : live.abortReason === "cancel" ? "cancelled"
        : "failed";
      if (cur && !isTerminal(cur.status) && canTransition(cur.status, status)) {
        this.setState(taskId, status, {
          finishedAt: Date.now(),
          error: status === "failed" ? { code: "exception", message, retryable: false } : undefined,
        });
      }
    } finally {
      if (live.timer) clearTimeout(live.timer);
      this.approvals.cancelTask(taskId);
      const final = this.store.getTask(taskId)!;
      live.resolveDone(final);
      this.live.delete(taskId);
    }
  }

  /* --------------------------- event hooks ---------------------------- */

  private onWorkerEvent(taskId: string, workerId: string, ev: WorkerEvent): void {
    // `kind` is authoritative = the worker event type (tool/text/status/done/error).
    // Any data.kind (e.g. a tool sub-kind like "read"/"edit") is preserved as subKind.
    const { kind: subKind, ...rest } = (ev.data ?? {}) as Record<string, unknown>;
    this.append(taskId, "output", ev.text, {
      workerId,
      kind: ev.type,
      ...(subKind !== undefined ? { subKind } : {}),
      ...rest,
    });
  }

  private async onPermission(taskId: string, req: PermissionRequest): Promise<PermissionDecision> {
    const { id, promise } = this.approvals.requestPermission(taskId, req);
    this.setState(taskId, "waiting", { waitingReason: `permission:${req.toolKind ?? "tool"}` });
    this.append(taskId, "waiting", `awaiting approval for ${req.toolKind ?? "tool"}`, {
      approvalId: id,
      kind: "permission",
      toolKind: req.toolKind,
      title: req.title,
    });
    this.signalWaiting(taskId);
    const decision = await promise;
    this.resumeFromWaiting(taskId, `approval decision: ${decision}`, { approvalId: id, decision });
    return decision;
  }

  private async onElicitation(taskId: string, req: ElicitationRequest): Promise<ElicitationResponse> {
    const { id, promise } = this.approvals.requestElicitation(taskId, req);
    this.setState(taskId, "waiting", { waitingReason: "elicitation" });
    this.append(taskId, "waiting", "agent requested input", { approvalId: id, kind: "elicitation" });
    this.signalWaiting(taskId);
    const resp = await promise;
    this.resumeFromWaiting(taskId, `elicitation: ${resp.action}`, { approvalId: id, action: resp.action });
    return resp;
  }

  /**
   * Resolve any `wait()` racing on this task's waiting signal, then re-arm it so
   * a later waiter does not observe a stale `waiting` state after a resume.
   */
  private signalWaiting(taskId: string): void {
    const live = this.live.get(taskId);
    if (!live) return;
    const rec = this.store.getTask(taskId);
    const resolvePrev = live.resolveWaiting;
    let next!: (r: TaskRecord) => void;
    live.waiting = new Promise<TaskRecord>((r) => (next = r));
    live.resolveWaiting = next;
    if (rec) resolvePrev(rec);
  }

  /**
   * Move a task out of `waiting`. Called synchronously by approve()/respond() so
   * there is no window where the record still reads `waiting` after a decision,
   * and again (as a no-op) when the worker-side handler resumes.
   */
  private resumeFromWaiting(taskId: string, text: string, data: Record<string, unknown>): void {
    const cur = this.store.getTask(taskId);
    if (cur?.status !== "waiting") return;
    if (this.live.get(taskId)?.abortReason) return;
    this.setState(taskId, "running", { waitingReason: undefined });
    this.append(taskId, "resumed", text, data);
  }

  private onTimeout(taskId: string): void {
    const live = this.live.get(taskId);
    if (!live) return;
    live.abortReason = "timeout";
    this.approvals.cancelTask(taskId);
    live.controller.abort();
    if (live.workerId) void this.provider.cancelWorkerTurn(live.workerId).catch(() => {});
  }

  /* ---------------------------- public API ---------------------------- */

  status(taskId: string): TaskRecord | undefined {
    return this.store.getTask(taskId);
  }

  result(taskId: string): TaskRecord | undefined {
    return this.store.getTask(taskId);
  }

  events(taskId: string, afterSequence = 0): TaskEvent[] {
    return this.store.listEvents(taskId, afterSequence);
  }

  listTasks(filter?: { status?: TaskStatus; limit?: number }): TaskRecord[] {
    return this.store.listTasks(filter);
  }

  pendingApprovals(taskId?: string) {
    return this.approvals.listPending(taskId);
  }

  approve(approvalId: string, decision: PermissionDecision): boolean {
    const taskId = this.approvals.taskIdOf(approvalId);
    const ok = this.approvals.decide(approvalId, decision);
    if (ok && taskId) {
      this.resumeFromWaiting(taskId, `approval decision: ${decision}`, { approvalId, decision });
    }
    return ok;
  }

  respond(approvalId: string, response: ElicitationResponse): boolean {
    const taskId = this.approvals.taskIdOf(approvalId);
    const ok = this.approvals.decide(approvalId, response);
    if (ok && taskId) {
      this.resumeFromWaiting(taskId, `elicitation: ${response.action}`, {
        approvalId,
        action: response.action,
      });
    }
    return ok;
  }

  async cancel(taskId: string): Promise<TaskRecord | undefined> {
    const cur = this.store.getTask(taskId);
    if (!cur || isTerminal(cur.status)) return cur;
    const live = this.live.get(taskId);
    if (live) {
      live.abortReason = "cancel";
      this.approvals.cancelTask(taskId);
      live.controller.abort();
      if (live.workerId) await this.provider.cancelWorkerTurn(live.workerId).catch(() => {});
      // Wait for the worker turn to settle so the caller observes a terminal
      // record. Bounded so a worker that ignores cancellation can't hang us.
      const grace = new Promise<TaskRecord>((r) => {
        const t = setTimeout(() => r(this.store.getTask(taskId)!), 5000);
        if (t.unref) t.unref();
      });
      await Promise.race([live.done, grace]);
    } else {
      // not live in this process (e.g. queued from a prior run) — settle directly
      this.setState(taskId, "cancelled", { finishedAt: Date.now() });
    }
    return this.store.getTask(taskId);
  }

  /**
   * Wait until the task is terminal OR enters `waiting` (needs approval) OR the
   * timeout elapses. Resolves with the current record in all cases.
   */
  async wait(taskId: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<TaskRecord | undefined> {
    const cur0 = this.store.getTask(taskId);
    if (!cur0) return undefined;
    if (isTerminal(cur0.status)) return cur0;

    const live = this.live.get(taskId);
    const deadline = Date.now() + timeoutMs;

    const timeoutPromise = new Promise<TaskRecord | undefined>((resolve) => {
      const t = setTimeout(
        () => resolve(this.store.getTask(taskId)),
        Math.max(0, deadline - Date.now()),
      );
      if (t.unref) t.unref();
    });

    if (!live) {
      // No live handle (e.g. after restart): poll the store for a terminal state.
      if (isTerminal(cur0.status)) return cur0;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        const r = this.store.getTask(taskId);
        if (r && isTerminal(r.status)) return r;
      }
      return this.store.getTask(taskId);
    }

    // Already waiting: safe to return now because approve()/respond() resume the
    // task synchronously, so a post-decision wait never sees a stale `waiting`.
    if (cur0.status === "waiting") return cur0;

    return Promise.race([live.done, live.waiting, timeoutPromise]);
  }

  /* ------------------------------ helpers ----------------------------- */

  private taskProfile(taskId: string): string {
    return this.store.getTask(taskId)?.profile ?? this.inferProfile();
  }
  private taskTimeout(taskId: string): number {
    return this.store.getTask(taskId)?.timeoutMs ?? this.defaultTimeoutMs;
  }

  private setState(taskId: string, status: TaskStatus, patch: Partial<TaskRecord> = {}): void {
    const cur = this.store.getTask(taskId);
    if (!cur) return;
    if (cur.status === status && Object.keys(patch).length === 0) return;
    if (!canTransition(cur.status, status)) {
      // ignore illegal late transitions (e.g. a settle after terminal)
      return;
    }
    this.store.updateTask(taskId, { status, ...patch });
    const map: Partial<Record<TaskStatus, TaskEvent["type"]>> = {
      running: cur.status === "waiting" ? "resumed" : "started",
      succeeded: "completed",
      failed: "failed",
      cancelled: "cancelled",
      timed_out: "timed_out",
    };
    const type = map[status];
    if (type && type !== "resumed") this.append(taskId, type, `status -> ${status}`);
  }

  private append(
    taskId: string,
    type: TaskEvent["type"],
    text?: string,
    data?: Record<string, unknown>,
  ): void {
    const ev = this.store.appendEvent(taskId, {
      eventId: randomUUID(),
      taskId,
      timestamp: new Date().toISOString(),
      type,
      text,
      data,
    });
    this.live.get(taskId)?.onEvent?.(ev);
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.live.keys()]) await this.cancel(id).catch(() => {});
  }
}
