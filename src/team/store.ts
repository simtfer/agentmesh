import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  TeamMessage,
  TeamMessageKind,
  TeamTurn,
  TeamTurnStatus,
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,
  author TEXT NOT NULL,
  authorName TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  mentions TEXT,
  hops INTEGER NOT NULL DEFAULT 0,
  rootId TEXT,
  replyTo TEXT,
  turnId TEXT,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, seq);
CREATE TABLE IF NOT EXISTS turns (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  memberId TEXT NOT NULL,
  channel TEXT NOT NULL,
  messageId TEXT NOT NULL,
  rootId TEXT NOT NULL,
  hops INTEGER NOT NULL,
  taskId TEXT,
  status TEXT NOT NULL,
  queuedAt INTEGER NOT NULL,
  startedAt INTEGER,
  endedAt INTEGER,
  approvalId TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_turns_member ON turns(memberId, status, seq);
CREATE INDEX IF NOT EXISTS idx_turns_root ON turns(rootId);
CREATE INDEX IF NOT EXISTS idx_turns_status ON turns(status, seq);
`;

/** Columns added after the first release; `CREATE TABLE IF NOT EXISTS` won't add them. */
const ADDED_COLUMNS: Array<{ table: string; column: string; decl: string }> = [
  { table: "messages", column: "hops", decl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "messages", column: "rootId", decl: "TEXT" },
];

type Row = Record<string, unknown>;

const str = (v: unknown): string | undefined => (v == null ? undefined : String(v));
const num = (v: unknown): number | undefined =>
  v == null ? undefined : typeof v === "bigint" ? Number(v) : (v as number);

function rowToMessage(r: Row): TeamMessage {
  const m: TeamMessage = {
    seq: num(r.seq) ?? 0,
    id: String(r.id),
    channel: String(r.channel),
    author: String(r.author),
    authorName: String(r.authorName),
    kind: (str(r.kind) ?? "chat") as TeamMessageKind,
    text: String(r.text),
    mentions: [],
    hops: num(r.hops) ?? 0,
    rootId: str(r.rootId) ?? String(r.id),
    createdAt: num(r.createdAt) ?? 0,
  };
  if (r.mentions != null) {
    try {
      const parsed = JSON.parse(String(r.mentions));
      if (Array.isArray(parsed)) m.mentions = parsed.map(String);
    } catch {
      /* a corrupt mention list must not make the message unreadable */
    }
  }
  const replyTo = str(r.replyTo);
  const turnId = str(r.turnId);
  if (replyTo) m.replyTo = replyTo;
  if (turnId) m.turnId = turnId;
  return m;
}

function rowToTurn(r: Row): TeamTurn {
  const t: TeamTurn = {
    seq: num(r.seq) ?? 0,
    id: String(r.id),
    memberId: String(r.memberId),
    channel: String(r.channel),
    messageId: String(r.messageId),
    rootId: String(r.rootId),
    hops: num(r.hops) ?? 0,
    status: String(r.status) as TeamTurnStatus,
    queuedAt: num(r.queuedAt) ?? 0,
  };
  const taskId = str(r.taskId);
  const startedAt = num(r.startedAt);
  const endedAt = num(r.endedAt);
  const approvalId = str(r.approvalId);
  const error = str(r.error);
  if (taskId) t.taskId = taskId;
  if (startedAt !== undefined) t.startedAt = startedAt;
  if (endedAt !== undefined) t.endedAt = endedAt;
  if (approvalId) t.approvalId = approvalId;
  if (error) t.error = error;
  return t;
}

export interface NewMessage {
  channel: string;
  author: string;
  authorName: string;
  kind?: TeamMessageKind;
  text: string;
  mentions?: string[];
  /** hand-off depth; 0 for a message a human wrote */
  hops?: number;
  /** thread root; defaults to the message's own id */
  rootId?: string;
  replyTo?: string;
  turnId?: string;
  createdAt?: number;
}

export interface NewTurn {
  memberId: string;
  channel: string;
  messageId: string;
  rootId: string;
  hops: number;
  status?: TeamTurnStatus;
}

/**
 * Durable conversation and inbox state for one team.
 *
 * Two tables, on purpose: `messages` is what humans read, `turns` is what the
 * scheduler works on. Keeping them separate means a turn can be requeued or
 * fail without rewriting history, and a message can exist without having caused
 * a turn (the user talking to the room, a system notice).
 */
export class TeamStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // Same ordering as the task store: a busy timeout must exist before the
    // first locking statement, otherwise two processes opening one team file
    // race the journal-mode switch and one dies with "database is locked".
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    for (const c of ADDED_COLUMNS) this.ensureColumn(c.table, c.column, c.decl);
  }

  private ensureColumn(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (cols.some((c) => String(c.name) === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  /* ---------------------------- messages ---------------------------- */

  createMessage(input: NewMessage): TeamMessage {
    const id = `msg-${randomUUID()}`;
    const createdAt = input.createdAt ?? Date.now();
    const mentions = input.mentions ?? [];
    const hops = input.hops ?? 0;
    // A message with no explicit root starts its own thread. Doing this here
    // means every caller gets a usable root id without having to invent one
    // before the row exists.
    const rootId = input.rootId ?? id;
    const res = this.db
      .prepare(
        `INSERT INTO messages (id, channel, author, authorName, kind, text, mentions, hops, rootId, replyTo, turnId, createdAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.channel,
        input.author,
        input.authorName,
        input.kind ?? "chat",
        input.text,
        mentions.length > 0 ? JSON.stringify(mentions) : null,
        hops,
        rootId,
        input.replyTo ?? null,
        input.turnId ?? null,
        createdAt,
      );
    return {
      seq: Number(res.lastInsertRowid),
      id,
      channel: input.channel,
      author: input.author,
      authorName: input.authorName,
      kind: input.kind ?? "chat",
      text: input.text,
      mentions,
      hops,
      rootId,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      createdAt,
    };
  }

  /** The last `limit` messages after `afterSeq`, returned oldest-first. */
  listMessages(channel: string, limit = 50, afterSeq = 0): TeamMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages WHERE channel=? AND seq>? ORDER BY seq DESC LIMIT ?
         ) ORDER BY seq ASC`,
      )
      .all(channel, afterSeq, limit) as Row[];
    return rows.map(rowToMessage);
  }

  getMessage(id: string): TeamMessage | undefined {
    const r = this.db.prepare("SELECT * FROM messages WHERE id=?").get(id) as Row | undefined;
    return r ? rowToMessage(r) : undefined;
  }

  channelStats(): Array<{ channel: string; count: number; lastAt: number }> {
    const rows = this.db
      .prepare(
        `SELECT channel, COUNT(*) AS n, MAX(createdAt) AS lastAt
           FROM messages WHERE kind='chat' GROUP BY channel`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      channel: String(r.channel),
      count: num(r.n) ?? 0,
      lastAt: num(r.lastAt) ?? 0,
    }));
  }

  /** Distinct members who have spoken (or been given a turn) in a channel. */
  channelParticipants(channel: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT memberId AS id FROM turns WHERE channel=?
         UNION
         SELECT author AS id FROM messages WHERE channel=? AND author NOT IN ('user','system')`,
      )
      .all(channel, channel) as Row[];
    return [...new Set(rows.map((r) => String(r.id)))];
  }

  memberLastSpoke(): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT author, MAX(createdAt) AS lastAt FROM messages
          WHERE author NOT IN ('user','system') GROUP BY author`,
      )
      .all() as Row[];
    const out = new Map<string, number>();
    for (const r of rows) out.set(String(r.author), num(r.lastAt) ?? 0);
    return out;
  }

  /* ------------------------------ turns ----------------------------- */

  createTurn(input: NewTurn): TeamTurn {
    const id = `turn-${randomUUID()}`;
    const queuedAt = Date.now();
    const status = input.status ?? "queued";
    const res = this.db
      .prepare(
        `INSERT INTO turns (id, memberId, channel, messageId, rootId, hops, status, queuedAt)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(id, input.memberId, input.channel, input.messageId, input.rootId, input.hops, status, queuedAt);
    return {
      seq: Number(res.lastInsertRowid),
      id,
      memberId: input.memberId,
      channel: input.channel,
      messageId: input.messageId,
      rootId: input.rootId,
      hops: input.hops,
      status,
      queuedAt,
    };
  }

  getTurn(id: string): TeamTurn | undefined {
    const r = this.db.prepare("SELECT * FROM turns WHERE id=?").get(id) as Row | undefined;
    return r ? rowToTurn(r) : undefined;
  }

  patchTurn(id: string, patch: Partial<Omit<TeamTurn, "id" | "seq">>): TeamTurn | undefined {
    const cur = this.getTurn(id);
    if (!cur) return undefined;
    const next: TeamTurn = { ...cur, ...patch };
    this.db
      .prepare(
        `UPDATE turns SET memberId=?, channel=?, messageId=?, rootId=?, hops=?, taskId=?,
          status=?, queuedAt=?, startedAt=?, endedAt=?, approvalId=?, error=? WHERE id=?`,
      )
      .run(
        next.memberId,
        next.channel,
        next.messageId,
        next.rootId,
        next.hops,
        next.taskId ?? null,
        next.status,
        next.queuedAt,
        next.startedAt ?? null,
        next.endedAt ?? null,
        next.approvalId ?? null,
        next.error ?? null,
        id,
      );
    return next;
  }

  nextQueuedTurn(memberId: string): TeamTurn | undefined {
    const r = this.db
      .prepare("SELECT * FROM turns WHERE memberId=? AND status='queued' ORDER BY seq ASC LIMIT 1")
      .get(memberId) as Row | undefined;
    return r ? rowToTurn(r) : undefined;
  }

  listTurns(filter?: { memberId?: string; channel?: string; status?: TeamTurnStatus; limit?: number }): TeamTurn[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter?.memberId) { where.push("memberId=?"); args.push(filter.memberId); }
    if (filter?.channel) { where.push("channel=?"); args.push(filter.channel); }
    if (filter?.status) { where.push("status=?"); args.push(filter.status); }
    const sql = `SELECT * FROM (
        SELECT * FROM turns ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY seq DESC LIMIT ?
      ) ORDER BY seq ASC`;
    args.push(filter?.limit ?? 50);
    return (this.db.prepare(sql).all(...(args as never[])) as Row[]).map(rowToTurn);
  }

  countQueued(memberId: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM turns WHERE memberId=? AND status='queued'")
      .get(memberId) as Row;
    return num(r.n) ?? 0;
  }

  hasQueuedTurn(memberId: string, messageId: string): boolean {    const r = this.db
      .prepare(
        "SELECT 1 AS hit FROM turns WHERE memberId=? AND messageId=? AND status IN ('queued','running','waiting') LIMIT 1",
      )
      .get(memberId, messageId) as Row | undefined;
    return Boolean(r);
  }

  countTurnsForRoot(rootId: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM turns WHERE rootId=?")
      .get(rootId) as Row;
    return num(r.n) ?? 0;
  }

  openTurnCounts(): { queued: number; running: number; waiting: number } {
    const rows = this.db
      .prepare(
        "SELECT status, COUNT(*) AS n FROM turns WHERE status IN ('queued','running','waiting') GROUP BY status",
      )
      .all() as Row[];
    const out = { queued: 0, running: 0, waiting: 0 };
    for (const r of rows) {
      const status = String(r.status) as keyof typeof out;
      if (status in out) out[status] = num(r.n) ?? 0;
    }
    return out;
  }

  /**
   * A process that died while a turn was live leaves `running`/`waiting` rows
   * behind. They are not resumed automatically: the task may already have had
   * side effects, and replaying it silently could apply them twice. They are
   * marked failed and returned so the caller can say so in the channel.
   */
  interruptLiveTurns(reason: string): TeamTurn[] {
    const live = this.db
      .prepare("SELECT * FROM turns WHERE status IN ('running','waiting') ORDER BY seq ASC")
      .all() as Row[];
    const turns = live.map(rowToTurn);
    if (turns.length === 0) return turns;
    const endedAt = Date.now();
    for (const t of turns) {
      this.patchTurn(t.id, { status: "failed", endedAt, error: reason });
    }
    return turns;
  }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }
}
