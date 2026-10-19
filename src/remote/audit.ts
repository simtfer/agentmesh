/**
 * Structured, append-only audit log for the Worker Daemon's control plane.
 *
 * Why: the daemon is the network-facing surface that can start real coding
 * agents, so an operator needs a tamper-evident trail of WHO was allowed in,
 * WHAT they submitted, and every approval / cancel / credential reload — both
 * for forensics and to spot an attacker probing the token.
 *
 * Design constraints:
 *  - Secrets are NEVER written. A token is reduced to a short, non-reversible
 *    fingerprint (`tokenFingerprint`) used only to correlate related attempts.
 *  - Agent output is untrusted data (PLAN §7) and is deliberately NOT logged
 *    here; this records control-plane decisions, not task text.
 *  - Writes are buffered through a stream, so a flood of failed-auth attempts
 *    cannot block the daemon's event loop with synchronous disk I/O.
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  type WriteStream,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/** Security-relevant control-plane events worth auditing. */
export type AuditEvent =
  | "daemon_start"
  | "daemon_stop"
  | "auth_ok"
  | "auth_fail"
  | "tls_reject"
  | "connection_open"
  | "connection_close"
  | "submit_ok"
  | "submit_rejected"
  | "approve"
  | "respond"
  | "cancel"
  | "attach_ok"
  | "attach_rejected"
  | "orphan_scheduled"
  | "orphan_cancelled"
  | "token_reload"
  | "token_reload_rejected"
  | "worker_created"
  | "worker_released"
  | "worker_reaped"
  | "release";

export interface AuditRecord {
  /** ISO-8601 timestamp, assigned at record() time. */
  ts: string;
  /** which daemon emitted this (correlates across restarts / hosts). */
  daemonId: string;
  event: AuditEvent;
  [k: string]: unknown;
}

export interface AuditLog {
  /** Append one structured record. Never throws — auditing must not break a request. */
  record(event: AuditEvent, fields?: Record<string, unknown>): void;
  /** Flush and release the underlying resource. */
  close(): Promise<void>;
}

/**
 * Short, non-reversible fingerprint of a token, for correlating auth events
 * without ever writing the secret. Returns "none" when no token was presented.
 * Truncated to 12 hex chars: enough to distinguish identities in a log, not
 * enough to be useful to an attacker who somehow obtains the log.
 */
export function tokenFingerprint(token: string | undefined): string {
  if (!token) return "none";
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12);
}

/** Discards everything; used when auditing is disabled. */
export class NoopAuditLog implements AuditLog {
  record(): void {}
  async close(): Promise<void> {}
}

/** Rotation defaults: 10 MiB per file, five archives kept (`file.1` … `file.5`). */
export const DEFAULT_AUDIT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_AUDIT_KEEP = 5;

/** Records held in memory while a rotation is in flight; beyond this we drop. */
const MAX_BUFFERED_RECORDS = 10_000;

export interface AuditRotationOptions {
  /** Rotate once the live file reaches this many bytes. 0 disables rotation. */
  maxBytes?: number;
  /** How many rotated archives to keep. 0 disables rotation. */
  keep?: number;
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Appends NDJSON records to a file, creating parent directories on demand.
 *
 * The trail is size-rotated: at `maxBytes` the live file becomes `file.1`, older
 * archives shift up (`file.1` → `file.2`, …) and the oldest is dropped once
 * `keep` is exceeded. Rotated files are therefore always *closed* archives —
 * unlike a copy-and-truncate, a reader can never see a half-written record
 * spliced onto reopened content, and on Windows the rename needs the handle
 * released, which is why rotation closes the stream first and buffers whatever
 * arrives meanwhile.
 */
export class FileAuditLog implements AuditLog {
  private stream: WriteStream;
  private closed = false;
  /** bytes in the current file, seeded from disk so a restart keeps counting */
  private bytes: number;
  private rotating = false;
  private buffered: string[] = [];
  private rotation?: Promise<void>;
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly keep: number;

  constructor(
    file: string,
    private readonly daemonId: string,
    opts: AuditRotationOptions = {},
  ) {
    this.file = path.resolve(file);
    mkdirSync(path.dirname(this.file), { recursive: true });
    this.maxBytes = Math.max(0, Math.trunc(opts.maxBytes ?? DEFAULT_AUDIT_MAX_BYTES));
    this.keep = Math.max(0, Math.trunc(opts.keep ?? DEFAULT_AUDIT_KEEP));
    this.bytes = fileSize(this.file);
    // Append, never truncate: an audit trail must survive restarts.
    this.stream = this.open();
  }

  private open(): WriteStream {
    const stream = createWriteStream(this.file, { flags: "a", encoding: "utf8" });
    // Swallow stream errors so a full/unwritable disk cannot crash the daemon.
    stream.on("error", () => {
      this.closed = true;
    });
    return stream;
  }

  record(event: AuditEvent, fields: Record<string, unknown> = {}): void {
    if (this.closed) return;
    const rec: AuditRecord = {
      ts: new Date().toISOString(),
      daemonId: this.daemonId,
      event,
      ...fields,
    };
    let line: string;
    try {
      line = JSON.stringify(rec) + "\n";
    } catch {
      // A field that cannot be serialised must not take the daemon down.
      line = JSON.stringify({ ts: rec.ts, daemonId: this.daemonId, event, note: "unserialisable" }) + "\n";
    }
    if (this.rotating) {
      // The stream is being closed for the rename; hold the record briefly.
      if (this.buffered.length < MAX_BUFFERED_RECORDS) this.buffered.push(line);
      return;
    }
    this.write(line);
    if (this.maxBytes > 0 && this.keep > 0 && this.bytes >= this.maxBytes) this.startRotation();
  }

  private write(line: string): void {
    this.bytes += Buffer.byteLength(line);
    try {
      this.stream.write(line);
    } catch {
      /* auditing is best-effort; never let it break the request path */
    }
  }

  private startRotation(): void {
    this.rotating = true;
    const current = this.stream;
    this.rotation = new Promise<void>((resolve) => {
      current.end(() => {
        try {
          this.shiftArchives();
        } catch {
          // Losing an archive beats crashing the daemon; keep appending.
        }
        this.bytes = 0;
        this.stream = this.open();
        const pending = this.buffered;
        this.buffered = [];
        for (const line of pending) this.write(line);
        this.rotating = false;
        resolve();
      });
    });
  }

  /** `file` → `file.1`, `file.1` → `file.2`, … dropping the oldest archive. */
  private shiftArchives(): void {
    for (let i = this.keep; i >= 1; i--) {
      const dst = `${this.file}.${i}`;
      const src = i === 1 ? this.file : `${this.file}.${i - 1}`;
      if (i === this.keep) rmSync(dst, { force: true });
      if (existsSync(src)) renameSync(src, dst);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // A rotation in flight owns the stream; let it reopen and drain first.
    if (this.rotation) await this.rotation.catch(() => {});
    this.closed = true;
    await new Promise<void>((resolve) => this.stream.end(() => resolve()));
  }
}

/**
 * Open the configured audit sink. An explicitly empty path ("") disables
 * auditing (NoopAuditLog); otherwise a file is opened at `configured` or, when
 * unset, at `defaultPath`.
 */
export function openAuditLog(
  daemonId: string,
  configured: string | undefined,
  defaultPath: string,
  opts: AuditRotationOptions = {},
): AuditLog {
  if (configured === "") return new NoopAuditLog();
  const file = configured && configured.length > 0 ? configured : defaultPath;
  return new FileAuditLog(file, daemonId, opts);
}
