import {
  createAcpRuntime,
  createFileSessionStore,
  createAgentRegistry,
  type AcpRuntime,
  type AcpRuntimeHandle,
  type AcpRuntimeEvent,
  type AcpRuntimeOptions,
  type AcpPermissionDecision,
  type AcpElicitationResponse,
} from "acpx/runtime";
import type {
  WorkerDriver,
  WorkerHandle,
  WorkerProfile,
  WorkerEvent,
  TurnResult,
  RunTurnOptions,
  PermissionRequest,
  ElicitationRequest,
} from "../types.js";

type PermissionMode = AcpRuntimeOptions["permissionMode"];

class AcpxWorkerHandle implements WorkerHandle {
  constructor(
    readonly id: string,
    readonly profile: string,
    readonly cwd: string,
    private runtime: AcpRuntime,
    private handle: AcpRuntimeHandle,
  ) {}

  async runTurn(
    text: string,
    opts?: RunTurnOptions,
  ): Promise<TurnResult> {
    const events: WorkerEvent[] = [];
    const emit = (e: Omit<WorkerEvent, "t">) => {
      const ev: WorkerEvent = { t: Date.now(), ...e };
      events.push(ev);
      opts?.onEvent?.(ev);
    };

    const requestId = crypto.randomUUID();
    const turn = this.runtime.startTurn({
      handle: this.handle,
      text,
      mode: "prompt",
      requestId,
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(opts?.onPermissionRequest
        ? {
            onPermissionRequest: async (req): Promise<AcpPermissionDecision> => {
              const raw = req.raw as { options?: Array<{ name?: string }> } | undefined;
              const generic: PermissionRequest = {
                id: req.sessionId,
                toolKind: req.inferredKind as string | undefined,
                title: raw?.options?.[0]?.name,
                raw: req.raw,
              };
              const decision = await opts.onPermissionRequest!(generic);
              return { outcome: decision };
            },
          }
        : {}),
      ...(opts?.onElicitation
        ? {
            onElicitation: async (req, ctx): Promise<AcpElicitationResponse> => {
              const generic: ElicitationRequest = { id: String(ctx.requestId), raw: req };
              const resp = await opts.onElicitation!(generic);
              const content = resp.content as
                | Record<string, never>
                | null
                | undefined;
              if (resp.action === "accept") {
                return { action: "accept", content: content ?? null };
              }
              return { action: resp.action };
            },
          }
        : {}),
    });

    let out = "";
    await turn.promptStarted;

    const drain = (async () => {
      for await (const ev of turn.events) {
        mapEvent(ev, out, emit, (chunk) => (out += chunk));
      }
    })();

    const result = await turn.result;
    await drain;

    if (result.status === "failed") {
      emit({ type: "error", text: result.error.message, data: { code: result.error.code } });
      return {
        status: "failed",
        text: out,
        events,
        error: { message: result.error.message, code: result.error.code },
      };
    }
    emit({
      type: "done",
      text: result.status,
      data: { stopReason: "stopReason" in result ? result.stopReason : undefined },
    });
    return {
      status: result.status,
      text: out,
      stopReason: "stopReason" in result ? result.stopReason : undefined,
      events,
    };
  }

  async cancel(): Promise<void> {
    await this.runtime.cancel({ handle: this.handle });
  }

  async close(reason = "worker closed"): Promise<void> {
    await this.runtime.close({ handle: this.handle, reason });
  }
}

function mapEvent(
  ev: AcpRuntimeEvent,
  _out: string,
  emit: (e: Omit<WorkerEvent, "t">) => void,
  append: (chunk: string) => void,
): void {
  switch (ev.type) {
    case "text_delta":
      // keep assistant output; drop reasoning/thought stream from the result text
      if (ev.stream !== "thought") append(ev.text);
      emit({ type: "text", text: ev.text, data: { stream: ev.stream ?? "output" } });
      break;
    case "tool_call":
      emit({
        type: "tool",
        text: ev.title ?? ev.text,
        data: { kind: ev.kind, status: ev.status, toolCallId: ev.toolCallId },
      });
      break;
    case "status":
      emit({ type: "status", text: ev.text, data: { tag: ev.tag } });
      break;
    case "error":
      emit({ type: "error", text: ev.message, data: { code: ev.code } });
      break;
    default:
      break;
  }
}

export interface AcpxDriverOptions {
  baseCwd: string;
  stateDir: string;
  overrides?: Record<string, string | string[]>;
  defaultPermissionMode?: string;
  /**
   * Extra environment for every spawned agent process. Used to propagate the
   * delegation depth (AGENTMESH_DELEGATION_DEPTH) so a nested agentmesh mounted
   * as the agent's MCP server inherits the chain depth for the recursion guard.
   */
  agentProcessEnv?: Record<string, string>;
}

/**
 * Drives real ACP agents (pi, opencode, codex, gemini, ...) via acpx's
 * in-process runtime. One runtime is shared by all workers; each worker gets a
 * unique persistent session keyed by its worker id.
 */
export class AcpxWorkerDriver implements WorkerDriver {
  readonly kind = "acpx" as const;
  private runtime: AcpRuntime;
  private permBySessionKey = new Map<string, PermissionMode>();

  constructor(private opts: AcpxDriverOptions) {
    const agentRegistry = createAgentRegistry({ overrides: opts.overrides ?? {} });
    this.runtime = createAcpRuntime({
      cwd: opts.baseCwd,
      sessionStore: createFileSessionStore({ stateDir: opts.stateDir }),
      agentRegistry,
      permissionMode: (opts.defaultPermissionMode ?? "approve-all") as PermissionMode,
      sessionPermissions: (session) => {
        const mode = this.permBySessionKey.get(session.sessionKey);
        return mode ? { permissionMode: mode } : undefined;
      },
      agentProcessEnv: opts.agentProcessEnv ?? {},
    });
  }

  async createWorker(
    profile: WorkerProfile,
    o: { id: string; cwd: string },
  ): Promise<WorkerHandle> {
    const agent = profile.agent ?? profile.name;
    if (profile.permissionMode) {
      this.permBySessionKey.set(o.id, profile.permissionMode as PermissionMode);
    }

    const handle = await this.runtime.ensureSession({
      sessionKey: o.id,
      agent,
      mode: "persistent",
      cwd: o.cwd,
    });

    if (profile.model && typeof this.runtime.setModel === "function") {
      try {
        await this.runtime.setModel({ handle, model: profile.model });
      } catch {
        // model selection is best-effort; not every adapter advertises it
      }
    }

    return new AcpxWorkerHandle(o.id, profile.name, o.cwd, this.runtime, handle);
  }

  async dispose(): Promise<void> {
    await this.runtime.shutdown?.();
  }
}
