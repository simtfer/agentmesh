import type {
  WorkerDriver,
  WorkerHandle,
  WorkerProfile,
  WorkerEvent,
  TurnResult,
  RunTurnOptions,
} from "../types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Deterministic in-process worker. No network, no API keys, no cost.
 * Used for the demo, tests, and as a stand-in while wiring up real agents.
 */
class MockWorkerHandle implements WorkerHandle {
  private cancelled = false;
  constructor(
    readonly id: string,
    readonly profile: string,
    readonly cwd: string,
    private behavior: NonNullable<WorkerProfile["mock"]>,
    private profileName: string,
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

    if (this.behavior.failOn && text.includes(this.behavior.failOn)) {
      emit({ type: "error", text: `mock failure triggered by "${this.behavior.failOn}"` });
      return {
        status: "failed",
        text: "",
        events,
        error: { message: "mock worker failed", code: "MOCK_FAIL" },
      };
    }

    emit({ type: "status", text: `mock[${this.profileName}] planning` });
    const toolCalls = this.behavior.toolCalls ?? 1;
    for (let i = 0; i < toolCalls; i++) {
      await sleep(Math.min(this.behavior.delayMs ?? 20, 50));
      if (opts?.signal?.aborted || this.cancelled) {
        return { status: "cancelled", text: "", events };
      }
      emit({ type: "tool", text: `read_file mock/${i}.ts`, data: { kind: "read" } });
    }

    // Optionally block on a permission request so the orchestrator enters `waiting`.
    if (this.behavior.requireApproval && opts?.onPermissionRequest) {
      const decision = await opts.onPermissionRequest({
        id: `${this.id}-edit`,
        toolKind: "edit",
        title: "mock wants to edit a file",
      });
      if (decision === "reject_once" || decision === "reject_always") {
        emit({ type: "error", text: `permission rejected (${decision})` });
        return {
          status: "failed",
          text: "",
          events,
          error: { message: "permission rejected", code: "REJECTED" },
        };
      }
      if (decision === "cancel" || opts.signal?.aborted || this.cancelled) {
        return { status: "cancelled", text: "", events };
      }
      emit({ type: "status", text: `permission granted (${decision})` });
    }

    const reply =
      this.behavior.reply ??
      `[${this.profileName}] done in ${this.cwd}: "${text.slice(0, 80)}${
        text.length > 80 ? "…" : ""
      }"`;

    await sleep(Math.min(this.behavior.delayMs ?? 20, 50));
    emit({ type: "text", text: reply });
    emit({ type: "done", text: "end_turn", data: { stopReason: "end_turn" } });
    return { status: "completed", text: reply, stopReason: "end_turn", events };
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }

  async close(): Promise<void> {
    this.cancelled = true;
  }
}

export class MockWorkerDriver implements WorkerDriver {
  readonly kind = "mock" as const;

  async createWorker(
    profile: WorkerProfile,
    opts: { id: string; cwd: string },
  ): Promise<WorkerHandle> {
    return new MockWorkerHandle(
      opts.id,
      profile.name,
      opts.cwd,
      profile.mock ?? {},
      profile.name,
    );
  }
}
