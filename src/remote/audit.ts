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
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/** Security-relevant control-plane events worth auditing. */
export type AuditEvent =
  | "daemon_start"
  | "daemon_stop"
  | "auth_ok"
  | "auth_fail"
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
  | "token_reload_rejected";

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

/** Appends NDJSON records to a file, creating parent directories on demand. */
export class FileAuditLog implements AuditLog {
  private stream: WriteStream;
  private closed = false;

  constructor(private readonly file: string, private readonly daemonId: string) {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    // Append, never truncate: an audit trail must survive restarts.
    this.stream = createWriteStream(path.resolve(file), { flags: "a", encoding: "utf8" });
    // Swallow stream errors so a full/unwritable disk cannot crash the daemon.
    this.stream.on("error", () => {
      this.closed = true;
    });
  }

  record(event: AuditEvent, fields: Record<string, unknown> = {}): void {
    if (this.closed) return;
    const rec: AuditRecord = {
      ts: new Date().toISOString(),
      daemonId: this.daemonId,
      event,
      ...fields,
    };
    try {
      this.stream.write(JSON.stringify(rec) + "\n");
    } catch {
      /* auditing is best-effort; never let it break the request path */
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
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
): AuditLog {
  if (configured === "") return new NoopAuditLog();
  const file = configured && configured.length > 0 ? configured : defaultPath;
  return new FileAuditLog(file, daemonId);
}
