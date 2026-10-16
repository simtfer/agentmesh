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
  ElicitationRequest,
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

    return new Promise<TurnResult>((resolve, reject) => {
      let settled = false;
      const ws = new WSClient(url, {
        headers: { authorization: `Bearer ${token}` },
        maxPayload: MAX_PAYLOAD_BYTES,
        handshakeTimeout: remote.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        ...(remote.ca ? { ca: remote.ca } : {}),
        ...(remote.cert ? { cert: remote.cert } : {}),
        ...(remote.key ? { key: remote.key } : {}),
      });
      this.activeWs = ws;

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
        this.activeWs = undefined;
        this.activeTaskId = undefined;
        if (opts?.signal) opts.signal.removeEventListener("abort", onAbort);
        try {
          if (ws.readyState === WSClient.OPEN || ws.readyState === WSClient.CONNECTING) ws.close();
        } catch {
          /* ignore */
        }
      };

      const send = (m: ClientMsg) => {
        if (ws.readyState === WSClient.OPEN) ws.send(encode(m));
      };

      const onAbort = () => {
        // Ask the daemon to cancel, then settle locally as cancelled.
        if (this.activeTaskId) send({ type: "cancel", taskId: this.activeTaskId });
        emit({ type: "status", text: "cancelled by master", data: { remote: true } });
        finish({ status: "cancelled", text: out, events });
      };
      if (opts?.signal) {
        if (opts.signal.aborted) {
          // let the socket open then cancel; simplest is to fail fast as cancelled
          ws.once("open", () => onAbort());
        } else {
          opts.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      ws.on("open", () => {
        send({
          type: "submit",
          submitId,
          profile: remoteProfile,
          prompt: text,
          cwd: this.cwd,
          ...(opts?.signal ? {} : {}),
        });
      });

      ws.on("message", (data) => {
        let msg: unknown;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (!isRecord(msg) || typeof msg.type !== "string") return;
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

      ws.on("error", (err: Error & { code?: string }) => {
        fail(`remote daemon connection error: ${err.message}`, err.code);
      });
      ws.on("close", () => {
        if (!settled) fail("remote daemon closed the connection before a result", "closed");
      });
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
