import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { TaskEvent, TaskRecord, TaskStatus, TaskStore } from "../types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  taskId TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  workerId TEXT,
  prompt TEXT NOT NULL,
  workingDirectory TEXT NOT NULL,
  status TEXT NOT NULL,
  sessionId TEXT,
  idempotencyKey TEXT,
  timeoutMs INTEGER NOT NULL,
  deadlineAt INTEGER,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  startedAt INTEGER,
  finishedAt INTEGER,
  text TEXT,
  structured TEXT,
  usage TEXT,
  stopReason TEXT,
  waitingReason TEXT,
  errorCode TEXT,
  errorMessage TEXT,
  errorRetryable INTEGER,
  dependsOn TEXT,
  blockedBy TEXT,
  attempt INTEGER,
  maxAttempts INTEGER,
  retryAt INTEGER,
  metadata TEXT
);
CREATE TABLE IF NOT EXISTS events (
  taskId TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  eventId TEXT NOT NULL,
  workerId TEXT,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  text TEXT,
  data TEXT,
  PRIMARY KEY (taskId, sequence)
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(taskId, sequence);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_idem ON tasks(idempotencyKey);
`;

/** Columns added after the first release; `CREATE TABLE IF NOT EXISTS` won't add them. */
const ADDED_COLUMNS: Array<{ table: string; column: string; decl: string }> = [
  { table: "tasks", column: "deadlineAt", decl: "INTEGER" },
  { table: "tasks", column: "structured", decl: "TEXT" },
  { table: "tasks", column: "usage", decl: "TEXT" },
  { table: "tasks", column: "dependsOn", decl: "TEXT" },
  { table: "tasks", column: "blockedBy", decl: "TEXT" },
  { table: "tasks", column: "attempt", decl: "INTEGER" },
  { table: "tasks", column: "maxAttempts", decl: "INTEGER" },
  { table: "tasks", column: "retryAt", decl: "INTEGER" },
];

type Row = Record<string, unknown>;

function num(v: unknown): number | undefined {
  if (v == null) return undefined;
  return typeof v === "bigint" ? Number(v) : (v as number);
}
function str(v: unknown): string | undefined {
  return v == null ? undefined : String(v);
}

function rowToTask(r: Row): TaskRecord {
  const rec: TaskRecord = {
    taskId: String(r.taskId),
    profile: String(r.profile),
    prompt: String(r.prompt),
    workingDirectory: String(r.workingDirectory),
    status: r.status as TaskStatus,
    timeoutMs: num(r.timeoutMs) ?? 0,
    createdAt: num(r.createdAt) ?? 0,
    updatedAt: num(r.updatedAt) ?? 0,
  };
  rec.workerId = str(r.workerId);
  rec.sessionId = str(r.sessionId);
  rec.idempotencyKey = str(r.idempotencyKey);
  rec.deadlineAt = num(r.deadlineAt);
  rec.attempt = num(r.attempt);
  rec.maxAttempts = num(r.maxAttempts);
  rec.retryAt = num(r.retryAt);
  for (const key of ["dependsOn", "blockedBy"] as const) {
    if (r[key] == null) continue;
    try {
      const parsed = JSON.parse(String(r[key]));
      if (Array.isArray(parsed)) rec[key] = parsed.map(String);
    } catch { /* ignore */ }
  }
  rec.startedAt = num(r.startedAt);
  rec.finishedAt = num(r.finishedAt);
  rec.text = str(r.text);
  // `structured` is arbitrary JSON — including a literal `null`, which a contract
  // may legitimately allow. Only a NULL column means "no structured result".
  if (r.structured != null) {
    try { rec.structured = JSON.parse(String(r.structured)); } catch { /* ignore */ }
  }
  if (r.usage != null) {
    try { rec.usage = JSON.parse(String(r.usage)) as TaskRecord["usage"]; } catch { /* ignore */ }
  }
  rec.stopReason = str(r.stopReason);
  rec.waitingReason = str(r.waitingReason);
  if (r.errorMessage != null) {
    rec.error = {
      code: str(r.errorCode) ?? "error",
      message: String(r.errorMessage),
      retryable: num(r.errorRetryable) === 1,
    };
  }
  if (r.metadata != null) {
    try { rec.metadata = JSON.parse(String(r.metadata)); } catch { /* ignore */ }
  }
  // strip undefined keys for cleaner JSON
  for (const k of Object.keys(rec) as Array<keyof TaskRecord>) {
    if (rec[k] === undefined) delete rec[k];
  }
  return rec;
}

function rowToEvent(r: Row): TaskEvent {
  const ev: TaskEvent = {
    eventId: String(r.eventId),
    taskId: String(r.taskId),
    sequence: num(r.sequence) ?? 0,
    timestamp: String(r.timestamp),
    type: r.type as TaskEvent["type"],
  };
  ev.workerId = str(r.workerId);
  ev.text = str(r.text);
  if (r.data != null) {
    try { ev.data = JSON.parse(String(r.data)); } catch { /* ignore */ }
  }
  return ev;
}

/** Durable TaskStore backed by node:sqlite (no native deps). */
export class SqliteTaskStore implements TaskStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // Two processes (or two test files) may open the same DB. Without a busy
    // timeout, any write while the other holds the write lock — including the
    // `journal_mode` switch, the schema DDL and the forward-migration below —
    // fails immediately with "database is locked". It must therefore be set
    // *before* the first locking statement, not after it.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    // Forward-migrate DBs created by an earlier version: additive, idempotent.
    for (const c of ADDED_COLUMNS) this.ensureColumn(c.table, c.column, c.decl);
  }

  private ensureColumn(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (cols.some((c) => String(c.name) === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  createTask(rec: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks (taskId, profile, workerId, prompt, workingDirectory, status,
          sessionId, idempotencyKey, timeoutMs, deadlineAt, createdAt, updatedAt, startedAt,
          finishedAt, text, structured, usage, stopReason, waitingReason, errorCode, errorMessage,
          errorRetryable, dependsOn, blockedBy, attempt, maxAttempts, retryAt, metadata)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        rec.taskId, rec.profile, rec.workerId ?? null, rec.prompt, rec.workingDirectory, rec.status,
        rec.sessionId ?? null, rec.idempotencyKey ?? null, rec.timeoutMs, rec.deadlineAt ?? null,
        rec.createdAt, rec.updatedAt,
        rec.startedAt ?? null, rec.finishedAt ?? null, rec.text ?? null,
        rec.structured === undefined ? null : JSON.stringify(rec.structured),
        rec.usage ? JSON.stringify(rec.usage) : null,
        rec.stopReason ?? null,
        rec.waitingReason ?? null, rec.error?.code ?? null, rec.error?.message ?? null,
        rec.error ? (rec.error.retryable ? 1 : 0) : null,
        rec.dependsOn ? JSON.stringify(rec.dependsOn) : null,
        rec.blockedBy ? JSON.stringify(rec.blockedBy) : null,
        rec.attempt ?? null, rec.maxAttempts ?? null, rec.retryAt ?? null,
        rec.metadata ? JSON.stringify(rec.metadata) : null,
      );
  }

  updateTask(taskId: string, patch: Partial<TaskRecord>): TaskRecord | undefined {
    const cur = this.getTask(taskId);
    if (!cur) return undefined;
    const next: TaskRecord = { ...cur, ...patch, taskId, updatedAt: patch.updatedAt ?? Date.now() };
    this.db
      .prepare(
        `UPDATE tasks SET profile=?, workerId=?, prompt=?, workingDirectory=?, status=?,
          sessionId=?, idempotencyKey=?, timeoutMs=?, deadlineAt=?, createdAt=?, updatedAt=?,
          startedAt=?, finishedAt=?, text=?, structured=?, usage=?, stopReason=?, waitingReason=?,
          errorCode=?, errorMessage=?, errorRetryable=?, dependsOn=?, blockedBy=?, attempt=?,
          maxAttempts=?, retryAt=?, metadata=?
         WHERE taskId=?`,
      )
      .run(
        next.profile, next.workerId ?? null, next.prompt, next.workingDirectory, next.status,
        next.sessionId ?? null, next.idempotencyKey ?? null, next.timeoutMs, next.deadlineAt ?? null,
        next.createdAt, next.updatedAt,
        next.startedAt ?? null, next.finishedAt ?? null, next.text ?? null,
        next.structured === undefined ? null : JSON.stringify(next.structured),
        next.usage ? JSON.stringify(next.usage) : null,
        next.stopReason ?? null,
        next.waitingReason ?? null, next.error?.code ?? null, next.error?.message ?? null,
        next.error ? (next.error.retryable ? 1 : 0) : null,
        next.dependsOn ? JSON.stringify(next.dependsOn) : null,
        next.blockedBy ? JSON.stringify(next.blockedBy) : null,
        next.attempt ?? null, next.maxAttempts ?? null, next.retryAt ?? null,
        next.metadata ? JSON.stringify(next.metadata) : null,
        taskId,
      );
    return next;
  }

  getTask(taskId: string): TaskRecord | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE taskId=?").get(taskId) as Row | undefined;
    return r ? rowToTask(r) : undefined;
  }

  listTasks(filter?: { status?: TaskStatus; limit?: number }): TaskRecord[] {
    if (filter?.status) {
      const rows = this.db
        .prepare("SELECT * FROM tasks WHERE status=? ORDER BY createdAt ASC LIMIT ?")
        .all(filter.status, filter.limit ?? -1) as Row[];
      return rows.map(rowToTask);
    }
    const rows = this.db
      .prepare("SELECT * FROM tasks ORDER BY createdAt ASC LIMIT ?")
      .all(filter?.limit ?? -1) as Row[];
    return rows.map(rowToTask);
  }

  findByIdempotencyKey(key: string): TaskRecord | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE idempotencyKey=? LIMIT 1").get(key) as
      | Row
      | undefined;
    return r ? rowToTask(r) : undefined;
  }

  appendEvent(taskId: string, ev: Omit<TaskEvent, "sequence">): TaskEvent {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM events WHERE taskId=?")
      .get(taskId) as Row;
    const sequence = num(row.n) ?? 1;
    this.db
      .prepare(
        `INSERT INTO events (taskId, sequence, eventId, workerId, timestamp, type, text, data)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        taskId, sequence, ev.eventId, ev.workerId ?? null, ev.timestamp, ev.type,
        ev.text ?? null, ev.data ? JSON.stringify(ev.data) : null,
      );
    return { ...ev, sequence };
  }

  listEvents(taskId: string, afterSequence = 0): TaskEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE taskId=? AND sequence>? ORDER BY sequence ASC")
      .all(taskId, afterSequence) as Row[];
    return rows.map(rowToEvent);
  }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }
}
