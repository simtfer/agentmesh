import type { ElicitationResponse, PermissionDecision } from "./types.js";

export type PendingKind = "permission" | "elicitation";

export interface PendingApproval {
  id: string;
  taskId: string;
  kind: PendingKind;
  request: unknown;
  createdAt: number;
}

interface Internal extends PendingApproval {
  resolve: (value: PermissionDecision | ElicitationResponse) => void;
}

/**
 * Bridges agent-initiated permission/elicitation requests to the master.
 * When a worker asks to run a risky tool (or asks the user something), the task
 * goes to `waiting` and blocks here until the master calls an approve/deny tool.
 */
export class ApprovalBroker {
  private pending = new Map<string, Internal>();
  private seq = 0;

  private create(kind: PendingKind, taskId: string, request: unknown) {
    this.seq += 1;
    const id = `apr-${Date.now().toString(36)}-${this.seq}`;
    let resolve!: (v: PermissionDecision | ElicitationResponse) => void;
    const promise = new Promise<PermissionDecision | ElicitationResponse>((r) => (resolve = r));
    this.pending.set(id, { id, taskId, kind, request, createdAt: Date.now(), resolve });
    return { id, promise };
  }

  requestPermission(taskId: string, request: unknown): { id: string; promise: Promise<PermissionDecision> } {
    const { id, promise } = this.create("permission", taskId, request);
    return { id, promise: promise as Promise<PermissionDecision> };
  }

  requestElicitation(taskId: string, request: unknown): { id: string; promise: Promise<ElicitationResponse> } {
    const { id, promise } = this.create("elicitation", taskId, request);
    return { id, promise: promise as Promise<ElicitationResponse> };
  }

  /** Resolve a pending approval. Returns false if unknown/already resolved. */
  decide(id: string, value: PermissionDecision | ElicitationResponse): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    p.resolve(value);
    return true;
  }

  /** The task an approval belongs to (before it is resolved). */
  taskIdOf(id: string): string | undefined {
    return this.pending.get(id)?.taskId;
  }

  /** How many requests are currently blocking a task. */
  size(): number {
    return this.pending.size;
  }

  listPending(taskId?: string): PendingApproval[] {
    return [...this.pending.values()]
      .filter((p) => (taskId ? p.taskId === taskId : true))
      .map(({ id, taskId, kind, request, createdAt }) => ({ id, taskId, kind, request, createdAt }));
  }

  /** Auto-cancel everything for a task (e.g. on cancel/timeout). */
  cancelTask(taskId: string): void {
    for (const [id, p] of [...this.pending.entries()]) {
      if (p.taskId === taskId) {
        this.pending.delete(id);
        p.resolve(p.kind === "permission" ? "cancel" : { action: "cancel" });
      }
    }
  }
}
