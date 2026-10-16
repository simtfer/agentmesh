import type {
  WorkerEvent,
  WorkerHandle,
  WorkerProfile,
  WorkerStatus,
} from "./types.js";

export interface WorkerRecord {
  id: string;
  profileName: string;
  profile: WorkerProfile;
  handle: WorkerHandle;
  status: WorkerStatus;
  cwd: string;
  worktree?: { path: string; branch: string; baseRepo: string };
  createdAt: number;
  lastTurnAt?: number;
  /** bounded ring buffer of recent events */
  events: WorkerEvent[];
  lastError?: string;
}

const EVENT_CAP = 500;

export class WorkerRegistry {
  private workers = new Map<string, WorkerRecord>();
  private seq = 0;

  nextId(profileName: string): string {
    this.seq += 1;
    const stamp = Date.now().toString(36);
    return `${profileName}-${stamp}-${this.seq}`;
  }

  register(rec: WorkerRecord): void {
    this.workers.set(rec.id, rec);
  }

  get(id: string): WorkerRecord | undefined {
    return this.workers.get(id);
  }

  require(id: string): WorkerRecord {
    const rec = this.workers.get(id);
    if (!rec) throw new Error(`no such worker: ${id}`);
    return rec;
  }

  list(): WorkerRecord[] {
    return [...this.workers.values()];
  }

  pushEvent(id: string, ev: WorkerEvent): void {
    const rec = this.workers.get(id);
    if (!rec) return;
    rec.events.push(ev);
    if (rec.events.length > EVENT_CAP) rec.events.splice(0, rec.events.length - EVENT_CAP);
  }

  async remove(id: string, reason = "killed"): Promise<void> {
    const rec = this.workers.get(id);
    if (!rec) return;
    try {
      await rec.handle.close(reason);
    } catch {
      /* ignore close errors */
    }
    rec.status = "closed";
    this.workers.delete(id);
  }

  async closeAll(reason = "shutdown"): Promise<void> {
    await Promise.all([...this.workers.keys()].map((id) => this.remove(id, reason)));
  }
}

/** Shape returned to MCP/CLI consumers (serializable, no live handles). */
export function describeWorker(rec: WorkerRecord, recentEvents = 0) {
  return {
    id: rec.id,
    profile: rec.profileName,
    driver: rec.profile.driver,
    status: rec.status,
    cwd: rec.cwd,
    worktree: rec.worktree?.path,
    createdAt: rec.createdAt,
    lastTurnAt: rec.lastTurnAt,
    lastError: rec.lastError,
    recentEvents: rec.events.slice(-recentEvents),
  };
}
