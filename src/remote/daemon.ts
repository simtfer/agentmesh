/**
 * Worker Daemon (machine B). Exposes a LOCAL agentmesh Orchestrator over an
 * authenticated WebSocket (+ minimal HTTP) so a remote master (machine A) can
 * run tasks on this host's agents.
 *
 * The daemon is a thin network shim: it reuses the exact same Orchestrator /
 * TaskManager / drivers used locally. ACP stdio never leaves this process — only
 * JSON control messages do, and only to callers presenting the shared token over
 * TLS (or loopback for development).
 */
import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import type { Orchestrator } from "../orchestrator.js";
import type { MeshConfig, TaskEvent } from "../types.js";
import { TERMINAL_TASK_STATUSES } from "../types.js";
import {
  encode,
  parseClientMsg,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  WS_PATH,
  HEALTH_PATH,
  PROFILES_PATH,
  type ServerMsg,
} from "./protocol.js";
import {
  SecurityError,
  assertCwdAllowed,
  assertSafeBind,
  bearerFromHeader,
  loadTls,
  resolveToken,
  tokensEqual,
} from "./security.js";

export interface WorkerDaemonOptions {
  config: MeshConfig;
  orchestrator: Orchestrator;
  host?: string;
  port?: number;
  /** env var name holding the bearer token (required unless allowInsecure) */
  tokenEnv?: string;
  /** explicit token value (tests); overrides tokenEnv */
  token?: string;
  allowCwd?: string[];
  tls?: { cert?: string; key?: string; ca?: string };
  /** permit a non-loopback bind without TLS (dangerous; explicit opt-in) */
  allowInsecure?: boolean;
  daemonId?: string;
  /** heartbeat interval ms (default 20000) */
  heartbeatMs?: number;
  /**
   * Grace window (ms) to keep an orphaned, still-running task alive after its
   * socket drops, so a client can `attach` and resume it. Default 0 = cancel
   * immediately (no orphans). Set > 0 to enable push-based resumption.
   */
  orphanGraceMs?: number;
}

const TERMINAL_EVENT_TYPES = new Set(["completed", "failed", "cancelled", "timed_out"]);

interface SocketState {
  ws: WebSocket;
  alive: boolean;
  tasks: Set<string>;
  closed: boolean;
}

export class WorkerDaemon {
  private server: http.Server | https.Server;
  private wss: WebSocketServer;
  private sockets = new Set<SocketState>();
  private heartbeat?: NodeJS.Timeout;
  private token: string | undefined;
  private host: string;
  private port: number;
  private allowCwd: string[] | undefined;
  private daemonId: string;
  private heartbeatMs: number;
  private exposedProfiles: string[];
  private orphanGraceMs: number;
  /** current socket receiving live events for a task (re-routed on attach) */
  private taskOwner = new Map<string, SocketState>();
  /** pending orphan-cancel timers, cleared if a client re-attaches in time */
  private orphanTimers = new Map<string, NodeJS.Timeout>();

  constructor(private opts: WorkerDaemonOptions) {
    this.host = opts.host ?? "127.0.0.1";
    this.port = opts.port ?? 8787;
    this.allowCwd = opts.allowCwd ?? opts.config.daemon?.allowCwd;
    this.daemonId = opts.daemonId ?? `daemon-${randomUUID().slice(0, 8)}`;
    this.heartbeatMs = opts.heartbeatMs ?? 20000;
    this.orphanGraceMs = opts.orphanGraceMs ?? opts.config.daemon?.orphanGraceMs ?? 0;
    this.token = opts.token ?? resolveToken(opts.tokenEnv ?? opts.config.daemon?.tokenEnv);
    this.exposedProfiles = this.computeExposedProfiles();

    const tls = loadTls(opts.tls ?? opts.config.daemon?.tls);
    // Fail-safe: never bind a reachable interface in cleartext without opt-in.
    assertSafeBind(this.host, Boolean(tls), Boolean(opts.allowInsecure));
    if (!this.token) {
      throw new SecurityError(
        "daemon requires a bearer token (set tokenEnv or token); refusing to start unauthenticated",
        "no_token",
      );
    }

    this.server = tls
      ? https.createServer({ cert: tls.cert, key: tls.key, ca: tls.ca }, this.onHttp)
      : http.createServer(this.onHttp);

    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
    this.server.on("upgrade", this.onUpgrade);
  }

  private computeExposedProfiles(): string[] {
    const explicit = this.opts.config.daemon?.exposeProfiles;
    const local = this.opts.config.profiles
      .filter((p) => p.driver !== "remote")
      .map((p) => p.name);
    return explicit && explicit.length > 0 ? explicit.filter((n) => local.includes(n)) : local;
  }

  /* ------------------------------- HTTP -------------------------------- */

  private onHttp = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://internal");
    // Liveness probe: no auth, no sensitive data.
    if (url.pathname === HEALTH_PATH) {
      this.json(res, 200, { ok: true, daemonId: this.daemonId, protocol: PROTOCOL_VERSION });
      return;
    }
    if (!this.authorized(req)) {
      this.json(res, 401, { error: "unauthorized" });
      return;
    }
    if (url.pathname === PROFILES_PATH) {
      this.json(res, 200, { daemonId: this.daemonId, profiles: this.exposedProfiles });
      return;
    }
    this.json(res, 404, { error: "not_found" });
  };

  private json(res: http.ServerResponse, code: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  }

  private authorized(req: http.IncomingMessage): boolean {
    const provided = bearerFromHeader(req.headers.authorization);
    return tokensEqual(provided, this.token);
  }

  /* ------------------------------ upgrade ------------------------------ */

  private onUpgrade = (req: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? "/", "http://internal");
    if (url.pathname !== WS_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    // Token may arrive via Authorization header or ?token= (clients that cannot
    // set upgrade headers). Both are compared in constant time.
    const headerToken = bearerFromHeader(req.headers.authorization);
    const queryToken = url.searchParams.get("token") ?? undefined;
    if (!tokensEqual(headerToken, this.token) && !tokensEqual(queryToken, this.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  };

  /* ---------------------------- connection ------------------------------ */

  private onConnection(ws: WebSocket): void {
    const state: SocketState = { ws, alive: true, tasks: new Set(), closed: false };
    this.sockets.add(state);

    this.send(state, {
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      daemonId: this.daemonId,
      profiles: this.exposedProfiles,
    });

    ws.on("pong", () => (state.alive = true));
    ws.on("message", (data) => {
      state.alive = true;
      this.onMessage(state, data.toString());
    });
    ws.on("close", () => this.onClose(state));
    ws.on("error", () => this.onClose(state));
  }

  private onClose(state: SocketState): void {
    if (state.closed) return;
    state.closed = true;
    this.sockets.delete(state);
    // Do not leave orphaned work running for a disconnected caller. Tasks that
    // already reached a terminal state are left as-is. With a grace window, a
    // still-running task is kept alive briefly so the client can re-attach and
    // resume its stream; otherwise it is cancelled immediately.
    for (const taskId of state.tasks) {
      if (this.taskOwner.get(taskId) === state) this.taskOwner.delete(taskId);
      const rec = this.opts.orchestrator.taskStatus(taskId);
      if (!rec || TERMINAL_TASK_STATUSES.has(rec.status)) continue;
      if (this.orphanGraceMs > 0) {
        this.scheduleOrphanCancel(taskId);
      } else {
        void this.opts.orchestrator.cancelTask(taskId).catch(() => {});
      }
    }
    try {
      state.ws.terminate();
    } catch {
      /* ignore */
    }
  }

  /** Cancel an orphaned task after the grace window unless a client re-attached. */
  private scheduleOrphanCancel(taskId: string): void {
    const existing = this.orphanTimers.get(taskId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.orphanTimers.delete(taskId);
      // Still orphaned (no owner re-attached) and not terminal → cancel.
      if (this.taskOwner.has(taskId)) return;
      const rec = this.opts.orchestrator.taskStatus(taskId);
      if (rec && !TERMINAL_TASK_STATUSES.has(rec.status)) {
        void this.opts.orchestrator.cancelTask(taskId).catch(() => {});
      }
    }, this.orphanGraceMs);
    if (timer.unref) timer.unref();
    this.orphanTimers.set(taskId, timer);
  }

  private onMessage(state: SocketState, raw: string): void {
    const msg = parseClientMsg(raw);
    if (!msg) {
      this.send(state, { type: "error", message: "malformed_message", code: "bad_request" });
      return;
    }
    switch (msg.type) {
      case "ping":
        this.send(state, { type: "pong" });
        return;
      case "submit":
        this.handleSubmit(state, msg);
        return;
      case "approve":
        this.opts.orchestrator.approveTask(msg.approvalId, msg.decision as never);
        return;
      case "respond":
        this.opts.orchestrator.respondTask(msg.approvalId, {
          action: msg.action as never,
          content: msg.content ?? null,
        });
        return;
      case "cancel": {
        const rec = this.opts.orchestrator.taskStatus(msg.taskId);
        if (rec && !TERMINAL_TASK_STATUSES.has(rec.status)) {
          void this.opts.orchestrator.cancelTask(msg.taskId).catch(() => {});
        }
        return;
      }
      case "query": {
        // Authoritative read from the persistent store; works for tasks from any
        // prior connection so a reconnecting master can reconcile, never guess.
        const rec = this.opts.orchestrator.taskResult(msg.taskId);
        this.send(
          state,
          rec
            ? { type: "query_result", queryId: msg.queryId, found: true, record: rec }
            : { type: "query_result", queryId: msg.queryId, found: false },
        );
        return;
      }
      case "attach":
        this.handleAttach(state, msg);
        return;
      default:
        return;
    }
  }

  private handleSubmit(state: SocketState, msg: import("./protocol.js").SubmitMsg): void {
    const orch = this.opts.orchestrator;
    const profile = msg.profile;
    if (!this.exposedProfiles.includes(profile)) {
      this.send(state, {
        type: "error",
        submitId: msg.submitId,
        message: `profile not exposed by daemon: ${profile}`,
        code: "profile_not_allowed",
      });
      return;
    }

    // Confine the working directory to the whitelist before any agent starts.
    let cwd: string;
    try {
      const requested = msg.cwd ?? orch.baseCwd;
      cwd = assertCwdAllowed(requested, this.allowCwd);
    } catch (e) {
      this.send(state, {
        type: "error",
        submitId: msg.submitId,
        message: e instanceof Error ? e.message : String(e),
        code: e instanceof SecurityError ? e.code : "cwd_not_whitelisted",
      });
      return;
    }

    let record;
    try {
      record = orch.submitTask(
        {
          prompt: msg.prompt,
          profile,
          cwd,
          timeoutMs: msg.timeoutMs,
          idempotencyKey: msg.idempotencyKey,
          metadata: msg.metadata,
        },
        {
          // Route each event to whoever currently owns the task. `append` fires
          // the synchronous `accepted` event before submitTask returns (so before
          // the owner is registered); fall back to the submitting socket for it.
          onEvent: (ev: TaskEvent) => {
            const owner = this.taskOwner.get(ev.taskId) ?? state;
            this.onTaskEvent(owner, ev);
          },
        },
      );
    } catch (e) {
      this.send(state, {
        type: "error",
        submitId: msg.submitId,
        message: e instanceof Error ? e.message : String(e),
        code: "submit_failed",
      });
      return;
    }

    state.tasks.add(record.taskId);
    this.taskOwner.set(record.taskId, state);
    this.send(state, { type: "submitted", submitId: msg.submitId, taskId: record.taskId });
  }

  /**
   * Re-attach a client to an existing task: replay persisted events after a
   * sequence boundary, then route live events here until the task is terminal.
   * Runs synchronously (no awaits) so no live event can interleave between the
   * replay snapshot and the ownership hand-off — the client sees a contiguous,
   * gap-free, duplicate-free stream.
   */
  private handleAttach(state: SocketState, msg: import("./protocol.js").AttachMsg): void {
    const orch = this.opts.orchestrator;
    const rec = orch.taskStatus(msg.taskId);
    if (!rec) {
      this.send(state, {
        type: "error",
        taskId: msg.taskId,
        message: `no such task: ${msg.taskId}`,
        code: "task_not_found",
      });
      return;
    }

    const after = typeof msg.afterSequence === "number" ? msg.afterSequence : 0;
    const replay = orch.taskEvents(msg.taskId, after);

    // Re-attached in time: cancel any pending orphan-cancel for this task.
    const timer = this.orphanTimers.get(msg.taskId);
    if (timer) {
      clearTimeout(timer);
      this.orphanTimers.delete(msg.taskId);
    }

    // Hand ownership over FIRST (synchronously) so subsequent live events route
    // here; the replay snapshot was taken above and covers everything up to now.
    this.taskOwner.set(msg.taskId, state);
    state.tasks.add(msg.taskId);

    this.send(state, {
      type: "attached",
      attachId: msg.attachId,
      taskId: msg.taskId,
      status: rec.status,
      replayFrom: after,
    });
    for (const ev of replay) {
      this.send(state, { type: "task_event", taskId: msg.taskId, event: ev });
    }
    // If it already finished, deliver the authoritative result and release.
    if (TERMINAL_TASK_STATUSES.has(rec.status)) {
      const final = orch.taskResult(msg.taskId);
      if (final) this.send(state, { type: "result", taskId: msg.taskId, record: final });
      this.taskOwner.delete(msg.taskId);
      state.tasks.delete(msg.taskId);
    }
  }

  private onTaskEvent(state: SocketState, ev: TaskEvent): void {
    const terminal = TERMINAL_EVENT_TYPES.has(ev.type);
    if (!state.closed) {
      this.send(state, { type: "task_event", taskId: ev.taskId, event: ev });
    }
    if (terminal) {
      // Release ownership and any pending orphan-cancel regardless of socket
      // state: the task is done, so there is nothing left to resume or cancel.
      if (this.taskOwner.get(ev.taskId) === state) this.taskOwner.delete(ev.taskId);
      const timer = this.orphanTimers.get(ev.taskId);
      if (timer) {
        clearTimeout(timer);
        this.orphanTimers.delete(ev.taskId);
      }
      if (!state.closed) {
        const record = this.opts.orchestrator.taskResult(ev.taskId);
        if (record) {
          this.send(state, { type: "result", taskId: ev.taskId, record });
          state.tasks.delete(ev.taskId);
        }
      }
    }
  }

  private send(state: SocketState, msg: ServerMsg): void {
    if (state.closed || state.ws.readyState !== WebSocket.OPEN) return;
    try {
      state.ws.send(encode(msg));
    } catch {
      /* drop on a broken pipe; onClose cleans up */
    }
  }

  /* ------------------------------ lifecycle ----------------------------- */

  async start(): Promise<{ host: string; port: number; url: string }> {
    await new Promise<void>((resolve) => this.server.listen(this.port, this.host, resolve));
    const addr = this.server.address() as AddressInfo;
    this.port = addr.port;

    this.heartbeat = setInterval(() => {
      for (const state of this.sockets) {
        if (!state.alive) {
          this.onClose(state);
          continue;
        }
        state.alive = false;
        try {
          state.ws.ping();
        } catch {
          this.onClose(state);
        }
      }
    }, this.heartbeatMs);
    if (this.heartbeat.unref) this.heartbeat.unref();

    const scheme = this.opts.config.daemon?.tls || this.opts.tls ? "https" : "http";
    return { host: this.host, port: this.port, url: `${scheme}://${this.host}:${this.port}` };
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const timer of this.orphanTimers.values()) clearTimeout(timer);
    this.orphanTimers.clear();
    this.taskOwner.clear();
    for (const state of [...this.sockets]) this.onClose(state);
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
