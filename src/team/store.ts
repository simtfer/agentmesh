import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  TeamBoardItem,
  TeamMessage,
  TeamMessageKind,
  TeamTurn,
  TeamTurnKind,
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
  kind TEXT NOT NULL DEFAULT 'message',
  messageId TEXT,
  rootId TEXT,
  hops INTEGER NOT NULL,
  taskId TEXT,
  sessionKey TEXT,
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
CREATE TABLE IF NOT EXISTS claims (
  messageId TEXT NOT NULL,
  memberId TEXT NOT NULL,
  decision TEXT NOT NULL,
  turnId TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (messageId, memberId)
);
CREATE INDEX IF NOT EXISTS idx_claims_message ON claims(messageId, decision);
`;

/** Columns added after the first release; `CREATE TABLE IF NOT EXISTS` won't add them. */
const ADDED_COLUMNS: Array<{ table: string; column: string; decl: string }> = [
  { table: "messages", column: "hops", decl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "messages", column: "rootId", decl: "TEXT" },
  { table: "turns", column: "kind", decl: "TEXT NOT NULL DEFAULT 'message'" },
  // Written when the turn starts, because that is when the member's current
  // generation — and therefore its key — is known.
  { table: "turns", column: "sessionKey", decl: "TEXT" },
];

/**
 * The first release declared `turns.messageId`/`rootId` NOT NULL, because every
 * turn answered a message. A pulse has nothing to answer, and SQLite cannot
 * relax a constraint in place, so that table has to be rebuilt once. Copied
 * column-by-column (not `SELECT *`) so a database from any earlier shape lands
 * in the current one.
 */
const TURNS_COLUMNS = [
  "seq",
  "id",
  "memberId",
  "channel",
  "kind",
  "messageId",
  "rootId",
  "hops",
  "taskId",
  "sessionKey",
  "status",
  "queuedAt",
  "startedAt",
  "endedAt",
  "approvalId",
  "error",
] as const;

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
    kind: (str(r.kind) ?? "message") as TeamTurnKind,
    hops: num(r.hops) ?? 0,
    status: String(r.status) as TeamTurnStatus,
    queuedAt: num(r.queuedAt) ?? 0,
  };
  const messageId = str(r.messageId);
  const rootId = str(r.rootId);
  const taskId = str(r.taskId);
  const sessionKey = str(r.sessionKey);
  const startedAt = num(r.startedAt);
  const endedAt = num(r.endedAt);
  const approvalId = str(r.approvalId);
  const error = str(r.error);
  if (messageId) t.messageId = messageId;
  if (rootId) t.rootId = rootId;
  if (taskId) t.taskId = taskId;
  if (sessionKey) t.sessionKey = sessionKey;
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
  /** omitted for a pulse: nothing was said to answer */
  messageId?: string;
  /** omitted for a pulse: it starts its own thread instead of continuing one */
  rootId?: string;
  hops: number;
  kind?: TeamTurnKind;
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
    this.relaxTurnsMessageId();
  }

  private ensureColumn(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (cols.some((c) => String(c.name) === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  /**
   * Rebuild `turns` once if `messageId` is still NOT NULL, so a turn can exist
   * without a message (a pulse). Runs inside a transaction: either the old rows
   * survive in the new shape or nothing changes.
   */
  private relaxTurnsMessageId(): void {
    const cols = this.db.prepare("PRAGMA table_info(turns)").all() as Row[];
    const messageId = cols.find((c) => String(c.name) === "messageId");
    if (!messageId || Number(messageId.notnull) === 0) return;
    const copied = cols.map((c) => String(c.name)).filter((n) => (TURNS_COLUMNS as readonly string[]).includes(n));
    const list = TURNS_COLUMNS.filter((c) => copied.includes(c)).join(", ");
    this.db.exec("BEGIN");
    try {
      this.db.exec("ALTER TABLE turns RENAME TO turns_v1");
      // Index names follow the renamed table, so re-create them under the real name.
      this.db.exec("DROP INDEX IF EXISTS idx_turns_member");
      this.db.exec("DROP INDEX IF EXISTS idx_turns_root");
      this.db.exec("DROP INDEX IF EXISTS idx_turns_status");
      this.db.exec(SCHEMA);
      this.db.exec(`INSERT INTO turns (${list}) SELECT ${list} FROM turns_v1`);
      this.db.exec("DROP TABLE turns_v1");
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
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
    const kind = input.kind ?? "message";
    const res = this.db
      .prepare(
        `INSERT INTO turns (id, memberId, channel, kind, messageId, rootId, hops, status, queuedAt)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.memberId,
        input.channel,
        kind,
        input.messageId ?? null,
        input.rootId ?? null,
        input.hops,
        status,
        queuedAt,
      );
    return {
      seq: Number(res.lastInsertRowid),
      id,
      memberId: input.memberId,
      channel: input.channel,
      kind,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.rootId ? { rootId: input.rootId } : {}),
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
          sessionKey=?, status=?, queuedAt=?, startedAt=?, endedAt=?, approvalId=?, error=? WHERE id=?`,
      )
      .run(
        next.memberId,
        next.channel,
        next.messageId ?? null,
        next.rootId ?? null,
        next.hops,
        next.taskId ?? null,
        next.sessionKey ?? null,
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

  /**
   * Turns that actually reached the harness and are over. This is the clock a
   * rotating session runs on: the count lives in the database, so a restart does
   * not rewind it, and a turn that never started (no task) does not age a
   * conversation it never touched.
   */
  countSettledTurns(memberId: string): number {
    const r = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM turns WHERE memberId=? AND taskId IS NOT NULL " +
          "AND status IN ('succeeded','failed','cancelled')",
      )
      .get(memberId) as Row;
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

  /* ------------------------------ the board ---------------------------- */

  /**
   * The room's board: messages the user posted without addressing anybody.
   *
   * A message like that used to be a dead end that the team apologised for.
   * It is really work looking for an owner, so it is kept here — with the same
   * age limit a queue would have, because there is no point offering yesterday's
   * remark to whoever happens to be free today. Finished work drops off the
   * board; it is in the transcript, which is where history belongs.
   */
  board(channel: string, ttlMs: number, now = Date.now()): TeamBoardItem[] {
    const cutoff = ttlMs > 0 ? now - ttlMs : 0;
    const rows = this.db
      .prepare(
        `SELECT m.*,
                (SELECT c.memberId FROM claims c
                  WHERE c.messageId = m.id AND c.decision IN ('taken','done') LIMIT 1) AS claimedBy
           FROM messages m
          WHERE m.channel = ? AND m.kind = 'chat' AND m.author = 'user'
            AND (m.mentions IS NULL OR m.mentions = '[]')
            AND m.createdAt >= ?
            AND NOT EXISTS (SELECT 1 FROM claims d WHERE d.messageId = m.id AND d.decision = 'done')
          ORDER BY m.seq ASC`,
      )
      .all(channel, cutoff) as Row[];
    const declined = this.db.prepare(
      "SELECT memberId FROM claims WHERE messageId = ? AND decision IN ('declined','dropped') ORDER BY at ASC",
    );
    return rows.map((r) => {
      const item: TeamBoardItem = {
        message: rowToMessage(r),
        declinedBy: (declined.all(String(r.id)) as Row[]).map((d) => String(d.memberId)),
      };
      const claimedBy = str(r.claimedBy);
      if (claimedBy) item.claimedBy = claimedBy;
      return item;
    });
  }

  /** How much work is waiting for an owner, for the status line. */
  unclaimedCount(ttlMs: number, now = Date.now()): number {
    const cutoff = ttlMs > 0 ? now - ttlMs : 0;
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m
          WHERE m.kind = 'chat' AND m.author = 'user'
            AND (m.mentions IS NULL OR m.mentions = '[]')
            AND m.createdAt >= ?
            AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.messageId = m.id AND c.decision IN ('taken','done'))`,
      )
      .get(cutoff) as Row;
    return num(r.n) ?? 0;
  }

  /**
   * Take a message off the board, atomically.
   *
   * Two members waking at the same moment must not both start the same piece of
   * work, so the check and the write happen in one `BEGIN IMMEDIATE`
   * transaction: the winner gets `true`, everybody else gets `false` and looks
   * for the next item. SQLite has a single writer, which is exactly what makes
   * this cheap.
   */
  claimFor(messageId: string, memberId: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const taken = this.db
        .prepare("SELECT memberId FROM claims WHERE messageId=? AND decision IN ('taken','done') LIMIT 1")
        .get(messageId) as Row | undefined;
      const passed = taken
        ? undefined
        : (this.db
            .prepare("SELECT decision FROM claims WHERE messageId=? AND memberId=? LIMIT 1")
            .get(messageId, memberId) as Row | undefined);
      if (taken || passed) {
        this.db.exec("COMMIT");
        return false;
      }
      this.db
        .prepare("INSERT INTO claims (messageId, memberId, decision, turnId, at) VALUES (?,?, 'taken', NULL, ?)")
        .run(messageId, memberId, Date.now());
      this.db.exec("COMMIT");
      return true;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Point a claim at the turn that is about to work on it. */
  attachClaimTurn(messageId: string, memberId: string, turnId: string): void {
    this.db
      .prepare("UPDATE claims SET turnId=? WHERE messageId=? AND memberId=?")
      .run(turnId, messageId, memberId);
  }

  /**
   * How the claim ended. `done` keeps the message off the board for good;
   * `declined`/`dropped` only stop *this* member being offered it again, so the
   * work returns to the room instead of dying with one refusal.
   */
  setClaim(messageId: string, memberId: string, decision: "done" | "declined" | "dropped"): void {
    this.db
      .prepare(
        `INSERT INTO claims (messageId, memberId, decision, turnId, at) VALUES (?,?,?, NULL, ?)
         ON CONFLICT(messageId, memberId) DO UPDATE SET decision=excluded.decision, at=excluded.at`,
      )
      .run(messageId, memberId, decision, Date.now());
  }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }
}
