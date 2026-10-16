import type { TaskEvent, TaskRecord, TaskStatus, TaskStore } from "../types.js";

/** In-memory TaskStore — used by tests and as a fallback when no DB path is set. */
export class MemoryTaskStore implements TaskStore {
  private tasks = new Map<string, TaskRecord>();
  private events = new Map<string, TaskEvent[]>();
  private seq = new Map<string, number>();
  private order: string[] = [];

  createTask(rec: TaskRecord): void {
    this.tasks.set(rec.taskId, { ...rec });
    this.events.set(rec.taskId, []);
    this.seq.set(rec.taskId, 0);
    this.order.push(rec.taskId);
  }

  updateTask(taskId: string, patch: Partial<TaskRecord>): TaskRecord | undefined {
    const cur = this.tasks.get(taskId);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, taskId, updatedAt: patch.updatedAt ?? Date.now() };
    this.tasks.set(taskId, next);
    return { ...next };
  }

  getTask(taskId: string): TaskRecord | undefined {
    const t = this.tasks.get(taskId);
    return t ? { ...t } : undefined;
  }

  listTasks(filter?: { status?: TaskStatus; limit?: number }): TaskRecord[] {
    let out = this.order.map((id) => ({ ...this.tasks.get(id)! }));
    if (filter?.status) out = out.filter((t) => t.status === filter.status);
    if (filter?.limit) out = out.slice(-filter.limit);
    return out;
  }

  findByIdempotencyKey(key: string): TaskRecord | undefined {
    return this.order.map((id) => this.tasks.get(id)!).find((t) => t.idempotencyKey === key);
  }

  appendEvent(taskId: string, ev: Omit<TaskEvent, "sequence">): TaskEvent {
    const n = (this.seq.get(taskId) ?? 0) + 1;
    this.seq.set(taskId, n);
    const full: TaskEvent = { ...ev, sequence: n };
    this.events.get(taskId)?.push(full);
    return full;
  }

  listEvents(taskId: string, afterSequence = 0): TaskEvent[] {
    return (this.events.get(taskId) ?? []).filter((e) => e.sequence > afterSequence);
  }

  close(): void {
    /* no-op */
  }
}
