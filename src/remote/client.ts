/**
 * Remote worker driver (machine A side). Implements the SAME WorkerHandle
 * contract as the local acpx/mock drivers, but proxies each turn to a Worker
 * Daemon over an authenticated WebSocket. This makes a remote worker completely
 * transparent to the local Orchestrator/TaskManager: it spawns, streams events,
 * round-trips approvals, cancels, and returns a TurnResult just like a local one.
 *
 * Security: the bearer token is read from an environment variable named by the
 * profile (`remote.tokenEnv`); it is never stored in config. TLS material (ca/
 * cert/key) is passed straight to the `ws` client.
 */
import { randomUUID } from "node:crypto";
import { WebSocket as WSClient } from "ws";
import type {
  WorkerDriver,
  WorkerHandle,
  WorkerProfile,
  WorkerEvent,
  WorkerEventType,
  TurnResult,
  RunTurnOptions,
  PermissionRequest,
  PermissionHandler,
  ElicitationRequest,
  ElicitationHandler,
  RemoteSettings,
  TaskEvent,
  TaskRecord,
} from "../types.js";
import {
  encode,
  isRecord,
  WS_PATH,
  MAX_PAYLOAD_BYTES,
  type ClientMsg,
  type ServerMsg,
} from "./protocol.js";
import { resolveToken } from "./security.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 15000;

/** http(s)://host:port → ws(s)://host:port/ws */
function toWsUrl(endpoint: string): string {
  const u = new URL(endpoint);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = WS_PATH;
  u.search = "";
  return u.toString();
}

function mapTerminal(record: TaskRecord, events: WorkerEvent[], text: string): TurnResult {
  switch (record.status) {
    case "succeeded":
      return { status: "completed", text: record.text ?? text, stopReason: record.stopReason, events };
    case "cancelled":
      return { status: "cancelled", text: record.text ?? text, events };
    case "timed_out":
      return {
        status: "failed",
        text: record.text ?? text,
        events,
        error: { message: "remote task timed out", code: "timed_out" },
      };
    default:
      return {
        status: "failed",
        text: record.text ?? text,
        events,
        error: record.error
          ? { message: record.error.message, code: record.error.code }
          : { message: "remote task failed", code: "remote_failed" },
      };
  }
}

class RemoteWorkerHandle implements WorkerHandle {
  private activeWs?: WSClient;
  private activeTaskId?: string;
  private closed = false;

  constructor(
    readonly id: string,
    readonly profile: string,
    readonly cwd: string,
    private wp: WorkerProfile,
  ) {}

  async runTurn(text: string, opts?: RunTurnOptions): Promise<TurnResult> {
    if (this.closed) throw new Error("remote worker is closed");
    const remote = this.wp.remote;
    if (!remote?.endpoint) throw new Error(`remote profile "${this.wp.name}" has no endpoint`);

    const token = resolveToken(remote.tokenEnv);
    if (!token) {
      throw new Error(
        `remote profile "${this.wp.name}": token env var "${remote.tokenEnv ?? ""}" is not set`,
      );
    }

    const events: WorkerEvent[] = [];
    let out = "";
    const emit = (e: Omit<WorkerEvent, "t">) => {
      const ev: WorkerEvent = { t: Date.now(), ...e };
      events.push(ev);
      opts?.onEvent?.(ev);
    };

    const url = toWsUrl(remote.endpoint);
    const remoteProfile = remote.remoteProfile ?? this.wp.name;
    const submitId = randomUUID();

    const resume = remote.resume ?? false;
    const maxAttempts = remote.reconnectAttempts ?? 3;
    const reconnectDelay = remote.reconnectDelayMs ?? 500;

    return new Promise<TurnResult>((resolve, reject) => {
      let settled = false;
      let lastSeq = 0; // highest task-event sequence seen, for attach replay
      let attempts = 0;
      let scheduling = false;
      let reconnectTimer: NodeJS.Timeout | undefined;
      let ws!: WSClient;

      const finish = (r: TurnResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(r);
      };
      const fail = (message: string, code?: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(code ? `${message} (${code})` : message));
      };
      const cleanup = () => {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        this.activeWs = undefined;
        this.activeTaskId = undefined;
        if (opts?.signal) opts.signal.removeEventListener("abort", onAbort);
        try {
          if (ws && (ws.readyState === WSClient.OPEN || ws.readyState === WSClient.CONNECTING)) {
            ws.close();
          }
        } catch {
          /* ignore */
        }
      };

      const send = (m: ClientMsg) => {
        if (ws && ws.readyState === WSClient.OPEN) ws.send(encode(m));
      };

      const onAbort = () => {
        // Ask the daemon to cancel, then settle locally as cancelled.
        if (this.activeTaskId) send({ type: "cancel", taskId: this.activeTaskId });
        emit({ type: "status", text: "cancelled by master", data: { remote: true } });
        finish({ status: "cancelled", text: out, events });
      };
      if (opts?.signal && !opts.signal.aborted) {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      // A dropped socket: re-attach when resume is enabled and we already know the
      // remote taskId; otherwise fail. Never loops on a pre-submit failure (no id).
      const onDisconnect = (message: string, code?: string) => {
        if (settled || scheduling) return;
        if (resume && this.activeTaskId && attempts < maxAttempts) {
          scheduling = true;
          attempts += 1;
          emit({
            type: "status",
            text: `connection lost; re-attaching (attempt ${attempts}/${maxAttempts})`,
            data: { remote: true, resume: true },
          });
          reconnectTimer = setTimeout(() => {
            scheduling = false;
            connect(true);
          }, reconnectDelay);
          if (reconnectTimer.unref) reconnectTimer.unref();
          return;
        }
        fail(message, code);
      };

      const connect = (isAttach: boolean) => {
        const sock = new WSClient(url, {
          headers: { authorization: `Bearer ${token}` },
          maxPayload: MAX_PAYLOAD_BYTES,
          handshakeTimeout: remote.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
          ...(remote.ca ? { ca: remote.ca } : {}),
          ...(remote.cert ? { cert: remote.cert } : {}),
          ...(remote.key ? { key: remote.key } : {}),
        });
        ws = sock;
        this.activeWs = sock;
        // Ignore events from a socket we've already replaced (post-reconnect).
        const stale = () => ws !== sock;

        sock.on("open", () => {
          if (stale()) return;
          if (opts?.signal?.aborted) {
            onAbort();
            return;
          }
          if (isAttach && this.activeTaskId) {
            send({
              type: "attach",
              attachId: randomUUID(),
              taskId: this.activeTaskId,
              afterSequence: lastSeq,
            });
          } else {
            send({ type: "submit", submitId, profile: remoteProfile, prompt: text, cwd: this.cwd });
          }
        });

        sock.on("message", (data) => {
          if (stale()) return;
          let msg: unknown;
          try {
            msg = JSON.parse(data.toString());
          } catch {
            return;
          }
          if (!isRecord(msg) || typeof msg.type !== "string") return;
          if (msg.type === "task_event") {
            const ev = (msg as { event?: TaskEvent }).event;
            if (ev && typeof ev.sequence === "number") {
              if (ev.sequence <= lastSeq) return; // dedupe replay overlap
              lastSeq = ev.sequence;
            }
          }
          this.onServerMsg(msg as unknown as ServerMsg, {
            emit,
            send,
            finish,
            fail,
            opts,
            appendText: (s) => (out += s),
            setTaskId: (id) => (this.activeTaskId = id),
          });
        });

        sock.on("error", (err: Error & { code?: string }) => {
          if (stale()) return;
          onDisconnect(`remote daemon connection error: ${err.message}`, err.code);
        });
        sock.on("close", () => {
          if (stale()) return;
          onDisconnect("remote daemon closed the connection before a result", "closed");
        });
      };

      connect(false);
    });
  }

  private onServerMsg(
    msg: ServerMsg,
    ctx: {
      emit: (e: Omit<WorkerEvent, "t">) => void;
      send: (m: ClientMsg) => void;
      finish: (r: TurnResult) => void;
      fail: (message: string, code?: string) => void;
      opts?: RunTurnOptions;
      appendText: (s: string) => void;
      setTaskId: (id: string) => void;
    },
  ): void {
    switch (msg.type) {
      case "welcome":
        // informational; the daemon echoes its exposed profiles
        return;
      case "submitted":
        ctx.setTaskId(msg.taskId);
        return;
      case "task_event":
        this.onTaskEvent(msg.event, ctx);
        return;
      case "result":
        ctx.finish(mapTerminal(msg.record, [], ""));
        return;
      case "error":
        ctx.fail(msg.message, msg.code);
        return;
      case "pong":
        return;
      default:
        return;
    }
  }

  private onTaskEvent(
    ev: TaskEvent,
    ctx: {
      emit: (e: Omit<WorkerEvent, "t">) => void;
      send: (m: ClientMsg) => void;
      opts?: RunTurnOptions;
      appendText: (s: string) => void;
    },
  ): void {
    if (ev.type === "output") {
      const kind = (ev.data?.kind as WorkerEventType) ?? "status";
      const text = ev.text ?? "";
      if (kind === "text") ctx.appendText(text);
      ctx.emit({ type: kind, text, data: { ...(ev.data ?? {}), remote: true } });
      return;
    }
    if (ev.type === "waiting") {
      const approvalId = ev.data?.approvalId as string | undefined;
      const kind = (ev.data?.kind as string | undefined) ?? "permission";
      if (!approvalId) return;
      if (kind === "elicitation") {
        const handler = ctx.opts?.onElicitation;
        if (!handler) {
          ctx.send({ type: "respond", approvalId, action: "cancel" });
          return;
        }
        const req: ElicitationRequest = { id: approvalId, raw: ev.data };
        void handler(req).then((resp) =>
          ctx.send({
            type: "respond",
            approvalId,
            action: resp.action,
            content: resp.content ?? null,
          }),
        );
        return;
      }
      // permission
      const handler = ctx.opts?.onPermissionRequest;
      if (!handler) {
        ctx.send({ type: "approve", approvalId, decision: "cancel" });
        return;
      }
      const req: PermissionRequest = {
        id: approvalId,
        toolKind: ev.data?.toolKind as string | undefined,
        title: ev.data?.title as string | undefined,
        raw: ev.data,
      };
      void handler(req).then((decision) => ctx.send({ type: "approve", approvalId, decision }));
      return;
    }
    // accepted/started/resumed/terminal lifecycle events are the REMOTE task's;
    // the local task machine generates its own, so we ignore them here.
  }

  async cancel(): Promise<void> {
    if (this.activeTaskId && this.activeWs?.readyState === WSClient.OPEN) {
      this.activeWs.send(encode({ type: "cancel", taskId: this.activeTaskId }));
    }
  }

  async close(_reason = "remote worker closed"): Promise<void> {
    this.closed = true;
    try {
      this.activeWs?.close();
    } catch {
      /* ignore */
    }
    this.activeWs = undefined;
  }
}

/**
 * Creates RemoteWorkerHandles. There is no shared runtime to boot (unlike acpx);
 * each handle opens a connection per turn, so createWorker is cheap and offline.
 */
export class RemoteWorkerDriver implements WorkerDriver {
  readonly kind = "remote" as const;

  async createWorker(profile: WorkerProfile, o: { id: string; cwd: string }): Promise<WorkerHandle> {
    return new RemoteWorkerHandle(o.id, profile.name, o.cwd, profile);
  }

  /**
   * Reconcile a task's authoritative state from the daemon. Opens a short-lived
   * connection, queries, and closes — independent of any live turn. Use it after
   * a dropped connection or a daemon restart to read the real outcome instead of
   * assuming success. Resolves `undefined` when the daemon has no such task.
   */
  queryTask(remote: RemoteSettings, taskId: string): Promise<TaskRecord | undefined> {
    return queryRemoteTask(remote, taskId);
  }

  async dispose(): Promise<void> {
    /* no shared resources */
  }
}

/**
 * One-shot reconciliation query against a daemon. Connects, asks for the
 * persisted TaskRecord, closes. Rejects on transport/auth errors and on a
 * missing/empty token; resolves `undefined` when the task is unknown to the
 * daemon (so callers can distinguish "not found" from "could not ask").
 */
export function queryRemoteTask(
  remote: RemoteSettings,
  taskId: string,
): Promise<TaskRecord | undefined> {
  if (!remote?.endpoint) throw new Error("queryRemoteTask: remote.endpoint is required");
  const token = resolveToken(remote.tokenEnv);
  if (!token) {
    return Promise.reject(
      new Error(`queryRemoteTask: token env var "${remote.tokenEnv ?? ""}" is not set`),
    );
  }

  const url = toWsUrl(remote.endpoint);
  const queryId = randomUUID();

  return new Promise<TaskRecord | undefined>((resolve, reject) => {
    let settled = false;
    const ws = new WSClient(url, {
      headers: { authorization: `Bearer ${token}` },
      maxPayload: MAX_PAYLOAD_BYTES,
      handshakeTimeout: remote.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      ...(remote.ca ? { ca: remote.ca } : {}),
      ...(remote.cert ? { cert: remote.cert } : {}),
      ...(remote.key ? { key: remote.key } : {}),
    });

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        if (ws.readyState === WSClient.OPEN || ws.readyState === WSClient.CONNECTING) ws.close();
      } catch {
        /* ignore */
      }
      fn();
    };

    ws.on("open", () => {
      ws.send(encode({ type: "query", queryId, taskId } satisfies ClientMsg));
    });

    ws.on("message", (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!isRecord(msg) || typeof msg.type !== "string") return;
      if (msg.type === "query_result" && msg.queryId === queryId) {
        const found = msg.found === true;
        const record = found ? (msg.record as TaskRecord) : undefined;
        done(() => resolve(record));
        return;
      }
      if (msg.type === "error") {
        done(() => reject(new Error(`${String(msg.message)}${msg.code ? ` (${msg.code})` : ""}`)));
      }
    });

    ws.on("error", (err: Error & { code?: string }) => {
      done(() => reject(new Error(`query connection error: ${err.message}${err.code ? ` (${err.code})` : ""}`)));
    });
    ws.on("close", () => {
      done(() => reject(new Error("query: daemon closed the connection before answering")));
    });
  });
}

export interface AttachOptions {
  /** resume after this event sequence (default 0 = replay the whole log) */
  afterSequence?: number;
  /** receive each replayed + live TaskEvent (deduplicated by sequence) */
  onEvent?: (ev: TaskEvent) => void;
  /** answer a permission request that arrives while attached */
  onPermissionRequest?: PermissionHandler;
  /** answer an elicitation request that arrives while attached */
  onElicitation?: ElicitationHandler;
  /** aborting detaches (closes the socket); it does NOT cancel the task */
  signal?: AbortSignal;
}

/**
 * Push-based resumption: attach to an existing task and stream its events from a
 * sequence boundary to completion. Use after a dropped connection (within the
 * daemon's orphan grace window) to resume a still-running task instead of
 * re-submitting it. Resolves with the authoritative terminal TaskRecord.
 *
 * Unlike `queryRemoteTask` (a one-shot pull), this holds the connection open,
 * replays missed events, forwards live ones, and round-trips approvals. Aborting
 * the signal detaches without cancelling the remote task.
 */
export function attachRemoteTask(
  remote: RemoteSettings,
  taskId: string,
  opts: AttachOptions = {},
): Promise<TaskRecord> {
  if (!remote?.endpoint) return Promise.reject(new Error("attachRemoteTask: remote.endpoint is required"));
  const token = resolveToken(remote.tokenEnv);
  if (!token) {
    return Promise.reject(
      new Error(`attachRemoteTask: token env var "${remote.tokenEnv ?? ""}" is not set`),
    );
  }

  const url = toWsUrl(remote.endpoint);
  const attachId = randomUUID();
  const after = typeof opts.afterSequence === "number" ? opts.afterSequence : 0;

  return new Promise<TaskRecord>((resolve, reject) => {
    let settled = false;
    let lastSeq = after;
    const ws = new WSClient(url, {
      headers: { authorization: `Bearer ${token}` },
      maxPayload: MAX_PAYLOAD_BYTES,
      handshakeTimeout: remote.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      ...(remote.ca ? { ca: remote.ca } : {}),
      ...(remote.cert ? { cert: remote.cert } : {}),
      ...(remote.key ? { key: remote.key } : {}),
    });

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      try {
        if (ws.readyState === WSClient.OPEN || ws.readyState === WSClient.CONNECTING) ws.close();
      } catch {
        /* ignore */
      }
      fn();
    };
    const send = (m: ClientMsg) => {
      if (ws.readyState === WSClient.OPEN) ws.send(encode(m));
    };

    const onAbort = () => {
      // Detach only; the daemon's orphan-grace policy decides the task's fate.
      done(() => reject(new Error("attach aborted")));
    };
    if (opts.signal) {
      if (opts.signal.aborted) ws.once("open", () => onAbort());
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    ws.on("open", () => {
      send({ type: "attach", attachId, taskId, afterSequence: after } satisfies ClientMsg);
    });

    ws.on("message", (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!isRecord(msg) || typeof msg.type !== "string") return;

      if (msg.type === "error") {
        done(() => reject(new Error(`${String(msg.message)}${msg.code ? ` (${msg.code})` : ""}`)));
        return;
      }
      if (msg.type === "task_event") {
        const ev = msg.event as TaskEvent;
        // Defensive dedupe: never replay an event at or below the last sequence.
        if (typeof ev.sequence === "number" && ev.sequence <= lastSeq) return;
        if (typeof ev.sequence === "number") lastSeq = ev.sequence;
        opts.onEvent?.(ev);
        if (ev.type === "waiting") handleWaiting(ev, send, opts);
        return;
      }
      if (msg.type === "result") {
        done(() => resolve(msg.record as TaskRecord));
        return;
      }
      // `attached` / `welcome` / `pong` are informational.
    });

    ws.on("error", (err: Error & { code?: string }) => {
      done(() => reject(new Error(`attach connection error: ${err.message}${err.code ? ` (${err.code})` : ""}`)));
    });
    ws.on("close", () => {
      done(() => reject(new Error("attach: daemon closed the connection before the task finished")));
    });
  });
}

/** Route a `waiting` event to the caller's approval handlers (mirrors runTurn). */
function handleWaiting(
  ev: TaskEvent,
  send: (m: ClientMsg) => void,
  opts: AttachOptions,
): void {
  const approvalId = ev.data?.approvalId as string | undefined;
  if (!approvalId) return;
  const kind = (ev.data?.kind as string | undefined) ?? "permission";
  if (kind === "elicitation") {
    if (!opts.onElicitation) {
      send({ type: "respond", approvalId, action: "cancel" });
      return;
    }
    const req: ElicitationRequest = { id: approvalId, raw: ev.data };
    void opts.onElicitation(req).then((resp) =>
      send({ type: "respond", approvalId, action: resp.action, content: resp.content ?? null }),
    );
    return;
  }
  if (!opts.onPermissionRequest) {
    send({ type: "approve", approvalId, decision: "cancel" });
    return;
  }
  const req: PermissionRequest = {
    id: approvalId,
    toolKind: ev.data?.toolKind as string | undefined,
    title: ev.data?.title as string | undefined,
    raw: ev.data,
  };
  void opts.onPermissionRequest(req).then((decision) => send({ type: "approve", approvalId, decision }));
}
