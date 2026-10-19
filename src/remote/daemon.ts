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
import path from "node:path";
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
  anyTokenEqual,
  bearerFromHeader,
  loadTls,
  resolveTokens,
  stageArtifacts,
  type StagedArtifact,
} from "./security.js";
import { openAuditLog, tokenFingerprint, type AuditLog } from "./audit.js";

export interface WorkerDaemonOptions {
  config: MeshConfig;
  orchestrator: Orchestrator;
  host?: string;
  port?: number;
  /** env var name(s) holding bearer token(s), comma-separated for rotation
   *  (required unless a token/tokens value is supplied directly) */
  tokenEnv?: string;
  /** explicit token value (tests); overrides tokenEnv */
  token?: string;
  /** explicit set of valid token values (tests / rotation); overrides tokenEnv */
  tokens?: string[];
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
  /** inject a custom audit sink (tests); defaults to the configured file log */
  audit?: AuditLog;
  /**
   * How long a reused worker (one conversation's ACP session) is kept after its
   * last turn before being reaped. Default 30 min; 0 disables reaping, which
   * leaves an agent process — logged in, with tools — alive until the daemon
   * stops. Reuse exists so a master can talk to the same agent repeatedly.
   */
  workerIdleMs?: number;
}

const TERMINAL_EVENT_TYPES = new Set(["completed", "failed", "cancelled", "timed_out"]);

/**
 * Replace `{{artifact:N}}` in the master's prompt with the absolute path the
 * daemon staged that artifact at. The master cannot know a path on this host, so
 * the token is the contract; an index with nothing behind it is left as-is
 * (visible in the task text) rather than silently blanked, so a version skew is
 * debuggable instead of the agent hunting for a file that never existed.
 */
function substituteArtifacts(prompt: string, staged: StagedArtifact[]): string {
  if (staged.length === 0) return prompt;
  return prompt.replace(/\{\{artifact:(\d+)\}\}/g, (match, n: string) => {
    const a = staged[Number(n)];
    return a ? a.path : match;
  });
}

interface SocketState {
  ws: WebSocket;
  alive: boolean;
  tasks: Set<string>;
  closed: boolean;
  /** short connection id, correlates audit records for one socket's lifetime */
  connId: string;
  /** peer address captured at upgrade time (audit only) */
  peer?: string;
}

export class WorkerDaemon {
  private server: http.Server | https.Server;
  private wss: WebSocketServer;
  private sockets = new Set<SocketState>();
  private heartbeat?: NodeJS.Timeout;
  private tokens: string[];
  private audit: AuditLog;
  private host: string;
  private port: number;
  private allowCwd: string[] | undefined;
  private daemonId: string;
  private heartbeatMs: number;
  private exposedProfiles: string[];
  private orphanGraceMs: number;
  /** true when a CA was configured, i.e. client certificates are mandatory */
  private mtls: boolean;
  /** current socket receiving live events for a task (re-routed on attach) */
  private taskOwner = new Map<string, SocketState>();
  /** pending orphan-cancel timers, cleared if a client re-attaches in time */
  private orphanTimers = new Map<string, NodeJS.Timeout>();
  /**
   * Conversations: an opaque ref → the local worker that owns its ACP session.
   * This is what makes a remote master able to talk to the SAME agent turn after
   * turn instead of briefing a new one each time. `active` guards against two
   * turns running on one worker at once.
   */
  private conversations = new Map<
    string,
    { workerId: string; sessionKey?: string; lastUsedAt: number; active: Set<string> }
  >();
  /** task → conversation, so a terminal event frees the worker for the next turn */
  private taskRef = new Map<string, string>();
  private workerIdleMs: number;
  private reaper?: NodeJS.Timeout;

  constructor(private opts: WorkerDaemonOptions) {
    this.host = opts.host ?? "127.0.0.1";
    this.port = opts.port ?? 8787;
    this.allowCwd = opts.allowCwd ?? opts.config.daemon?.allowCwd;
    this.daemonId = opts.daemonId ?? `daemon-${randomUUID().slice(0, 8)}`;
    this.heartbeatMs = opts.heartbeatMs ?? 20000;
    this.orphanGraceMs = opts.orphanGraceMs ?? opts.config.daemon?.orphanGraceMs ?? 0;
    this.workerIdleMs = opts.workerIdleMs ?? opts.config.daemon?.workerIdleMs ?? 30 * 60_000;
    this.tokens = this.resolveTokens();
    this.exposedProfiles = this.computeExposedProfiles();
    this.audit =
      opts.audit ??
      openAuditLog(
        this.daemonId,
        opts.config.daemon?.auditPath,
        path.join(opts.orchestrator.workdir, "daemon-audit.ndjson"),
        {
          maxBytes: opts.config.daemon?.auditMaxBytes,
          keep: opts.config.daemon?.auditKeep,
        },
      );

    const tls = loadTls(opts.tls ?? opts.config.daemon?.tls);
    this.mtls = Boolean(tls?.ca);
    // Fail-safe: never bind a reachable interface in cleartext without opt-in.
    assertSafeBind(this.host, Boolean(tls), Boolean(opts.allowInsecure));
    if (this.tokens.length === 0) {
      throw new SecurityError(
        "daemon requires a bearer token (set tokenEnv or token); refusing to start unauthenticated",
        "no_token",
      );
    }

    this.server = tls
      ? https.createServer(
          {
            cert: tls.cert,
            key: tls.key,
            // A configured CA turns the deployment into mutual TLS: the daemon
            // then demands a client certificate signed by that CA and refuses
            // the handshake otherwise. That is what makes a cross-host bind
            // defensible — a stolen bearer token alone is not enough to reach
            // an agent that can run tools on this machine.
            ...(tls.ca ? { ca: tls.ca, requestCert: true, rejectUnauthorized: true } : {}),
          },
          this.onHttp,
        )
      : http.createServer(this.onHttp);

    // A rejected client certificate fails inside TLS, before any HTTP handler
    // runs, so it would otherwise leave no trace in the audit trail. Record it
    // (message only — no peer payloads, no cert contents).
    this.server.on("tlsClientError", (err: Error, socket) => {
      this.audit.record("tls_reject", {
        peer: (socket as import("node:net").Socket).remoteAddress,
        reason: err.message,
      });
    });

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

  /**
   * Resolve the accepted bearer tokens. Explicit values (tests) win; otherwise
   * read from the configured env var name(s), which may be comma-separated to
   * carry several valid tokens at once during a rotation.
   */
  private resolveTokens(): string[] {
    if (this.opts.tokens && this.opts.tokens.length > 0) {
      return this.opts.tokens.filter((t) => t.length > 0);
    }
    if (this.opts.token) return [this.opts.token];
    return resolveTokens(this.opts.tokenEnv ?? this.opts.config.daemon?.tokenEnv);
  }

  /**
   * Re-read accepted tokens from the environment for zero-downtime rotation.
   * An operator adds a new secret alongside the old, migrates clients, calls
   * this (or sends SIGHUP), then drops the old env var and calls it again.
   * Refuses to rotate to an empty set so the daemon can never become either
   * unauthenticated or lock itself out. Returns the new valid-token count.
   */
  reloadTokens(): number {
    const next = this.resolveTokens();
    if (next.length === 0) {
      this.audit.record("token_reload_rejected", { reason: "empty_set" });
      throw new SecurityError(
        "refusing to rotate to an empty token set; daemon would become unauthenticated",
        "no_token",
      );
    }
    this.tokens = next;
    // Count only — never the values or their fingerprints (a rotated-out secret
    // should stop being correlatable from this point).
    this.audit.record("token_reload", { accepted: this.tokens.length });
    return this.tokens.length;
  }

  /* ------------------------------- HTTP -------------------------------- */

  private onHttp = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://internal");
    // Liveness probe: no auth, no sensitive data.
    if (url.pathname === HEALTH_PATH) {
      this.json(res, 200, { ok: true, daemonId: this.daemonId, protocol: PROTOCOL_VERSION });
      return;
    }
    const peer = req.socket.remoteAddress;
    if (!this.authorized(req)) {
      this.audit.record("auth_fail", {
        surface: "http",
        path: url.pathname,
        peer,
        tokenFp: tokenFingerprint(bearerFromHeader(req.headers.authorization)),
      });
      this.json(res, 401, { error: "unauthorized" });
      return;
    }
    this.audit.record("auth_ok", { surface: "http", path: url.pathname, peer });
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
    return anyTokenEqual(provided, this.tokens);
  }

  /* ------------------------------ upgrade ------------------------------ */

  private onUpgrade = (req: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? "/", "http://internal");
    const peer = (socket as import("node:net").Socket).remoteAddress;
    if (url.pathname !== WS_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    // Token may arrive via Authorization header or ?token= (clients that cannot
    // set upgrade headers). Both are compared in constant time against every
    // accepted token, so a rotated-in secret works without a restart.
    const headerToken = bearerFromHeader(req.headers.authorization);
    const queryToken = url.searchParams.get("token") ?? undefined;
    if (!anyTokenEqual(headerToken, this.tokens) && !anyTokenEqual(queryToken, this.tokens)) {
      this.audit.record("auth_fail", {
        surface: "ws",
        peer,
        tokenFp: tokenFingerprint(headerToken ?? queryToken),
      });
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    this.audit.record("auth_ok", {
      surface: "ws",
      peer,
      tokenFp: tokenFingerprint(headerToken ?? queryToken),
    });
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, peer));
  };

  /* ---------------------------- connection ------------------------------ */

  private onConnection(ws: WebSocket, peer?: string): void {
    const state: SocketState = {
      ws,
      alive: true,
      tasks: new Set(),
      closed: false,
      connId: randomUUID().slice(0, 8),
      peer,
    };
    this.sockets.add(state);
    this.audit.record("connection_open", { connId: state.connId, peer });

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
    this.audit.record("connection_close", {
      connId: state.connId,
      peer: state.peer,
      openTasks: state.tasks.size,
    });
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
    this.audit.record("orphan_scheduled", { taskId, graceMs: this.orphanGraceMs });
    const timer = setTimeout(() => {
      this.orphanTimers.delete(taskId);
      // Still orphaned (no owner re-attached) and not terminal → cancel.
      if (this.taskOwner.has(taskId)) return;
      const rec = this.opts.orchestrator.taskStatus(taskId);
      if (rec && !TERMINAL_TASK_STATUSES.has(rec.status)) {
        this.audit.record("orphan_cancelled", { taskId });
        void this.opts.orchestrator.cancelTask(taskId).catch(() => {});
      }
    }, this.orphanGraceMs);
    if (timer.unref) timer.unref();
    this.orphanTimers.set(taskId, timer);
  }

  private onMessage(state: SocketState, raw: string): void {
    const msg = parseClientMsg(raw);
    if (!msg) {
      this.audit.record("submit_rejected", { connId: state.connId, reason: "malformed_message" });
      this.send(state, { type: "error", message: "malformed_message", code: "bad_request" });
      return;
    }
    switch (msg.type) {
      case "release":
        void this.handleRelease(state, msg);
        return;
      case "ping":
        this.send(state, { type: "pong" });
        return;
      case "submit":
        void this.handleSubmit(state, msg);
        return;
      case "approve":
        this.audit.record("approve", {
          connId: state.connId,
          approvalId: msg.approvalId,
          decision: msg.decision,
        });
        this.opts.orchestrator.approveTask(msg.approvalId, msg.decision as never);
        return;
      case "respond":
        this.audit.record("respond", {
          connId: state.connId,
          approvalId: msg.approvalId,
          action: msg.action,
        });
        this.opts.orchestrator.respondTask(msg.approvalId, {
          action: msg.action as never,
          content: msg.content ?? null,
        });
        return;
      case "cancel": {
        const rec = this.opts.orchestrator.taskStatus(msg.taskId);
        this.audit.record("cancel", {
          connId: state.connId,
          taskId: msg.taskId,
          terminal: rec ? TERMINAL_TASK_STATUSES.has(rec.status) : undefined,
        });
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

  private async handleSubmit(state: SocketState, msg: import("./protocol.js").SubmitMsg): Promise<void> {
    const orch = this.opts.orchestrator;
    const profile = msg.profile;
    if (!this.exposedProfiles.includes(profile)) {
      this.audit.record("submit_rejected", {
        connId: state.connId,
        reason: "profile_not_allowed",
        profile,
      });
      this.send(state, {
        type: "error",
        submitId: msg.submitId,
        message: `profile not exposed by daemon: ${profile}`,
        code: "profile_not_allowed",
      });
      return;
    }

    // Echo the effective key, including a profile-level default the client
    // cannot see. Same precedence as the orchestrator: per-submit wins.
    let sessionKey: string | undefined =
      msg.sessionKey ?? this.opts.config.profiles.find((p) => p.name === profile)?.session;

    // A `workerRef` turns this submit into the next turn of an existing
    // conversation: same worker, same agent session, same directory.
    let conv = msg.workerRef ? this.conversations.get(msg.workerRef) : undefined;
    let ref = msg.workerRef;
    const reject = (code: string, message: string, reason = code) => {
      this.audit.record("submit_rejected", {
        connId: state.connId,
        reason,
        profile,
        ...(msg.workerRef ? { workerRef: msg.workerRef } : {}),
        ...(msg.sessionKey ? { sessionKey: msg.sessionKey } : {}),
        ...(msg.cwd ? { requestedCwd: msg.cwd } : {}),
      });
      this.send(state, { type: "error", submitId: msg.submitId, message, code });
    };

    if (msg.workerRef && !conv && !msg.sessionKey) {
      // Expired, released, or minted by another daemon: never silently fall back
      // to a fresh worker — the master would believe it was continuing a thread.
      reject(
        "worker_ref_unknown",
        "unknown workerRef: the conversation expired or was released",
        "worker_ref_unknown",
      );
      return;
    }
    // A `sessionKey` names a conversation, not a handle. It is the one thing
    // that survives a daemon restart (the ACP session record is on disk keyed by
    // it), so it is resolved here into the live conversation when one exists —
    // then this turn goes through the same profile, cwd and busy checks as a
    // workerRef turn instead of taking a second path.
    if (!conv && msg.sessionKey) {
      const found = [...this.conversations].find(([, c]) => c.sessionKey === msg.sessionKey);
      if (found) {
        ref = found[0];
        conv = found[1];
      }
    }
    // The ref may have died with a previous daemon process while the key still
    // names a stored session: continue by key rather than echo a dead handle.
    if (!conv && ref && !this.conversations.has(ref)) ref = undefined;
    if (conv && conv.active.size > 0) {
      reject(
        "worker_ref_busy",
        "this conversation still has a running task; wait for it before the next turn",
        "worker_ref_busy",
      );
      return;
    }
    if (conv) {
      // Never let a client relabel an existing conversation: the worker keeps
      // the session it was spawned with, so accepting a different key here would
      // make the master believe it holds a conversation it does not.
      if (msg.sessionKey && msg.sessionKey !== conv.sessionKey) {
        reject(
          "session_key_mismatch",
          `this worker belongs to session "${conv.sessionKey ?? "(unkeyed)"}", not "${msg.sessionKey}"`,
          "session_key_mismatch",
        );
        return;
      }
      if (conv.sessionKey) sessionKey = conv.sessionKey;
    }

    // Confine the working directory to the whitelist before any agent starts.
    // A conversation keeps the directory it was created with; re-checking a
    // follow-up that omits `cwd` would reject a legitimate turn.
    let cwd: string;
    if (conv) {
      const wrec = orch.getWorkerRecord(conv.workerId);
      if (!wrec) {
        if (ref) this.conversations.delete(ref);
        reject("worker_ref_unknown", "the worker behind this conversation is gone", "worker_ref_lost");
        return;
      }
      if (wrec.profileName !== profile) {
        reject(
          "worker_ref_profile_mismatch",
          `this conversation belongs to profile "${wrec.profileName}", not "${profile}"`,
          "worker_ref_profile_mismatch",
        );
        return;
      }
      if (msg.cwd && path.resolve(msg.cwd) !== path.resolve(wrec.cwd)) {
        reject(
          "worker_ref_cwd_mismatch",
          `a conversation cannot move: it runs in ${wrec.cwd}; release the ref to start elsewhere`,
          "worker_ref_cwd_mismatch",
        );
        return;
      }
      cwd = wrec.cwd;
    } else {
      try {
        const requested = msg.cwd ?? orch.baseCwd;
        cwd = assertCwdAllowed(requested, this.allowCwd);
      } catch (e) {
        // The prompt is untrusted master content and is never logged; the
        // requested cwd is recorded because a whitelist escape is the signal here.
        this.audit.record("submit_rejected", {
          connId: state.connId,
          reason: "cwd_not_whitelisted",
          profile,
          requestedCwd: msg.cwd ?? orch.baseCwd,
        });
        this.send(state, {
          type: "error",
          submitId: msg.submitId,
          message: e instanceof Error ? e.message : String(e),
          code: e instanceof SecurityError ? e.code : "cwd_not_whitelisted",
        });
        return;
      }
    }

    // Artifacts travel with the submit (cross-host handoff). Stage them in the
    // daemon's own state dir *before* the task exists: never into a whitelisted
    // repo, and a rejected artifact costs neither a worker nor a scheduler slot.
    let staged: StagedArtifact[] = [];
    if (msg.artifacts && msg.artifacts.length > 0) {
      try {
        staged = stageArtifacts(msg.artifacts, orch.workdir);
      } catch (e) {
        const code = e instanceof SecurityError ? e.code : "artifact_invalid";
        this.audit.record("submit_rejected", {
          connId: state.connId,
          reason: "artifact_rejected",
          profile,
          code,
          artifacts: msg.artifacts.map((a) => a.name),
        });
        this.send(state, {
          type: "error",
          submitId: msg.submitId,
          message: e instanceof Error ? e.message : String(e),
          code,
        });
        return;
      }
    }

    // The master refers to artifacts as `{{artifact:N}}` because it cannot know a
    // path here; resolve them now that the bytes are on this host.
    const prompt = substituteArtifacts(msg.prompt, staged);

    // A new conversation does NOT spawn its worker here: the task machine spawns
    // it when the task actually starts, so the scheduler's concurrency cap still
    // bounds how many agent processes exist (pre-spawning would put one behind
    // every queued task). The ref is therefore issued when the task starts — see
    // onTaskEvent — which is well before the next turn needs it.
    if (conv) conv.lastUsedAt = Date.now();

    let record;
    try {
      record = orch.submitTask(
        {
          prompt,
          profile,
          ...(conv ? { workerId: conv.workerId } : {}),
          // A pinned key is only meaningful when this turn spawns: with a live
          // conversation the worker is already bound to the same session.
          ...(!conv && msg.sessionKey ? { sessionKey: msg.sessionKey } : {}),
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
      this.audit.record("submit_rejected", {
        connId: state.connId,
        reason: "submit_failed",
        profile,
        cwd,
      });
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
    if (conv) {
      // A reused worker is busy until this turn's terminal event.
      conv.active.add(record.taskId);
      if (ref) this.taskRef.set(record.taskId, ref);
    }
    this.audit.record("submit_ok", {
      connId: state.connId,
      taskId: record.taskId,
      profile,
      cwd,
      ...(conv ? { workerRef: ref, reused: true } : { reused: false }),
      ...(staged.length > 0
        ? { artifacts: staged.length, artifactBytes: staged.reduce((n, a) => n + a.bytes, 0) }
        : {}),
    });
    this.send(state, {
      type: "submitted",
      submitId: msg.submitId,
      taskId: record.taskId,
      ...(ref ? { workerRef: ref } : {}),
      ...(sessionKey ? { sessionKey } : {}),
    });
  }

  /**
   * Free a conversation on request. Best-effort by design: the master closes a
   * handle it may never have used, and a missing ref is not an error worth
   * failing a shutdown over.
   */
  private async handleRelease(
    state: SocketState,
    msg: import("./protocol.js").ReleaseMsg,
  ): Promise<void> {
    const ok = await this.releaseConversation(msg.workerRef);
    this.audit.record("release", { connId: state.connId, workerRef: msg.workerRef, ok });
    this.send(state, { type: "released", workerRef: msg.workerRef, ok });
  }

  private async releaseConversation(ref: string): Promise<boolean> {
    const conv = this.conversations.get(ref);
    if (!conv) return false;
    this.conversations.delete(ref);
    for (const taskId of conv.active) this.taskRef.delete(taskId);
    await this.opts.orchestrator.killWorker(conv.workerId).catch(() => {});
    this.audit.record("worker_released", { workerRef: ref, workerId: conv.workerId });
    return true;
  }

  /** Reap conversations that have been idle past `workerIdleMs`. */
  private async reapIdleWorkers(): Promise<void> {
    const cutoff = Date.now() - this.workerIdleMs;
    for (const [ref, conv] of [...this.conversations]) {
      if (conv.active.size > 0 || conv.lastUsedAt > cutoff) continue;
      this.conversations.delete(ref);
      await this.opts.orchestrator.killWorker(conv.workerId).catch(() => {});
      this.audit.record("worker_reaped", {
        workerRef: ref,
        workerId: conv.workerId,
        idleMs: Date.now() - conv.lastUsedAt,
      });
    }
  }

  private async releaseAllConversations(): Promise<void> {
    for (const [ref, conv] of [...this.conversations]) {
      this.conversations.delete(ref);
      await this.opts.orchestrator.killWorker(conv.workerId).catch(() => {});
      this.audit.record("worker_released", { workerRef: ref, workerId: conv.workerId });
    }
    this.taskRef.clear();
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
      this.audit.record("attach_rejected", {
        connId: state.connId,
        taskId: msg.taskId,
        reason: "task_not_found",
      });
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

    this.audit.record("attach_ok", {
      connId: state.connId,
      taskId: msg.taskId,
      afterSequence: after,
      replayed: replay.length,
      status: rec.status,
    });
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

    // Bind a new conversation the moment its worker exists. Everything that
    // follows (approvals, events, the result) already flows on this socket; this
    // only tells the client which handle to bring back for the next turn.
    if (ev.type === "started" && !this.taskRef.has(ev.taskId)) {
      const workerId = ev.workerId ?? this.opts.orchestrator.taskStatus(ev.taskId)?.workerId;
      if (workerId) {
        // A worker can already have a conversation: it was spawned under a
        // pinned `sessionKey` and this is its second turn. Minting a second ref
        // would leave two handles on one worker, and releasing either would kill
        // the other — so reuse the existing one.
        const existing = [...this.conversations].find(([, c]) => c.workerId === workerId);
        const sessionKey = this.opts.orchestrator.getWorkerRecord(workerId)?.sessionKey;
        let ref: string;
        let conv: { workerId: string; sessionKey?: string; lastUsedAt: number; active: Set<string> };
        if (existing) {
          [ref, conv] = existing;
          conv.active.add(ev.taskId);
          conv.lastUsedAt = Date.now();
          if (sessionKey) conv.sessionKey = sessionKey;
        } else {
          ref = `w-${randomUUID()}`;
          conv = {
            workerId,
            ...(sessionKey ? { sessionKey } : {}),
            lastUsedAt: Date.now(),
            active: new Set([ev.taskId]),
          };
          this.conversations.set(ref, conv);
          this.audit.record("worker_created", {
            connId: state.connId,
            workerRef: ref,
            workerId,
            taskId: ev.taskId,
            ...(sessionKey ? { sessionKey } : {}),
          });
        }
        this.taskRef.set(ev.taskId, ref);
        if (!state.closed) {
          this.send(state, {
            type: "worker_bound",
            taskId: ev.taskId,
            workerRef: ref,
            ...(conv.sessionKey ? { sessionKey: conv.sessionKey } : {}),
          });
        }
      }
    }

    if (terminal) {
      // The conversation's worker is free again; its session stays alive so the
      // next turn continues the same thread.
      const ref = this.taskRef.get(ev.taskId);
      if (ref) {
        this.taskRef.delete(ev.taskId);
        const conv = this.conversations.get(ref);
        if (conv) {
          conv.active.delete(ev.taskId);
          conv.lastUsedAt = Date.now();
        }
      }
    }
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
    // A failed bind (port taken, address not local) arrives as an 'error' event,
    // not as a thrown exception — without this the process dies on an unhandled
    // event with a stack trace, which is the worst possible message for the most
    // common two-host mistake: another daemon is already listening.
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once("error", onError);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
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

    // Reap conversations nobody came back to. A reused worker is a whole agent
    // process, authenticated on this host: keeping it forever would turn every
    // abandoned master into a resident agent.
    if (this.workerIdleMs > 0) {
      this.reaper = setInterval(
        () => void this.reapIdleWorkers(),
        Math.min(this.workerIdleMs, 60_000),
      );
      if (this.reaper.unref) this.reaper.unref();
    }

    const scheme = this.opts.config.daemon?.tls || this.opts.tls ? "https" : "http";
    this.audit.record("daemon_start", {
      host: this.host,
      port: this.port,
      tls: scheme === "https",
      mtls: this.mtls,
      profiles: this.exposedProfiles,
      acceptedTokens: this.tokens.length,
    });
    return { host: this.host, port: this.port, url: `${scheme}://${this.host}:${this.port}` };
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reaper) clearInterval(this.reaper);
    await this.releaseAllConversations();
    for (const timer of this.orphanTimers.values()) clearTimeout(timer);
    this.orphanTimers.clear();
    this.taskOwner.clear();
    for (const state of [...this.sockets]) this.onClose(state);
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.audit.record("daemon_stop", {});
    await this.audit.close().catch(() => {});
  }
}
