import type {
  WorkerDriver,
  WorkerHandle,
  WorkerProfile,
  WorkerEvent,
  TurnResult,
  RunTurnOptions,
} from "../types.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Drop undefined entries so an absent field stays absent instead of becoming 0. */
function stripUndefined(obj: Record<string, number | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * Deterministic in-process worker. No network, no API keys, no cost.
 * Used for the demo, tests, and as a stand-in while wiring up real agents.
 */
class MockWorkerHandle implements WorkerHandle {
  private cancelled = false;
  /** Running session cost, mirroring how ACP reports cost as a cumulative figure. */
  private spent = 0;
  constructor(
    readonly id: string,
    readonly profile: string,
    readonly cwd: string,
    private behavior: NonNullable<WorkerProfile["mock"]>,
    private profileName: string,
    /** this worker was born into one of the profile's "fail first N turns" slots */
    private failTurn = false,
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

    // Optionally materialise files so handoff diff/base tests have real changes.
    if (this.behavior.writeFiles) {
      const entries = Object.entries(this.behavior.writeFiles);
      for (const [rel, content] of entries) {
        const target = path.resolve(this.cwd, rel);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
      }
      emit({
        type: "tool",
        text: `write_file ${entries.map(([rel]) => rel).join(", ")}`,
        data: { kind: "write" },
      });
    }

    const reply =
      this.behavior.reply ??
      `[${this.profileName}] done in ${this.cwd}: "${text.slice(0, 80)}${
        text.length > 80 ? "…" : ""
      }"`;

    // Optional usage reports so token/cost roll-up has something deterministic to
    // roll up. Each report scales the previous one, i.e. it carries the running
    // totals — the same "cumulative, last one wins" shape real adapters send, so
    // a test can tell a correct roll-up from a naive sum.
    const u = this.behavior.usage;
    if (u) {
      const reports = Math.max(1, Math.trunc(u.reports ?? 1));
      for (let i = 1; i <= reports; i++) {
        const breakdown = stripUndefined({
          inputTokens: u.inputTokens === undefined ? undefined : u.inputTokens * i,
          outputTokens: u.outputTokens === undefined ? undefined : u.outputTokens * i,
          cachedReadTokens: u.cachedReadTokens === undefined ? undefined : u.cachedReadTokens * i,
          cachedWriteTokens: u.cachedWriteTokens === undefined ? undefined : u.cachedWriteTokens * i,
          thoughtTokens: u.thoughtTokens === undefined ? undefined : u.thoughtTokens * i,
          totalTokens: u.totalTokens === undefined ? undefined : u.totalTokens * i,
        });
        let cost: { amount: number; currency?: string } | undefined;
        if (u.cost) {
          // Cumulative, like ACP's session cost: it grows across the reports of a
          // turn *and* across turns on the same worker, which is exactly what makes
          // delta accounting (task cost, not session cost) testable.
          this.spent += u.cost.amount;
          cost = { amount: this.spent, ...(u.cost.currency ? { currency: u.cost.currency } : {}) };
        }
        emit({
          type: "usage",
          text: `usage report ${i}/${reports}`,
          data: {
            ...(Object.keys(breakdown).length > 0 ? { breakdown } : {}),
            ...(cost ? { cost } : {}),
            ...(u.contextUsed !== undefined ? { contextUsed: u.contextUsed } : {}),
            ...(u.contextSize !== undefined ? { contextSize: u.contextSize } : {}),
          },
        });
      }
    }

    await sleep(Math.min(this.behavior.delayMs ?? 20, 50));

    // `failFirst` failures happen *after* the turn's work (and its usage report),
    // modelling a run that spent tokens and then died — which is exactly the case
    // where a retry has to accumulate the wasted spend.
    if (this.failTurn) {
      emit({ type: "error", text: "mock transient failure (failFirst)" });
      return {
        status: "failed",
        text: "",
        events,
        error: { message: "mock worker failed", code: "MOCK_FAIL" },
      };
    }

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
  /**
   * Per-profile "transient failure" budget left (`mock.failFirst`). It lives on
   * the driver, not the worker, so a retry — which spawns a *new* worker — still
   * observes the failure: that is the whole point of modelling it this way.
   */
  private failBudget = new Map<string, number>();

  async createWorker(
    profile: WorkerProfile,
    opts: { id: string; cwd: string },
  ): Promise<WorkerHandle> {
    let failTurn = false;
    if (profile.mock?.failFirst !== undefined) {
      const left = this.failBudget.get(profile.name) ?? Math.max(0, Math.trunc(profile.mock.failFirst));
      if (left > 0) {
        this.failBudget.set(profile.name, left - 1);
        failTurn = true;
      }
    }
    return new MockWorkerHandle(
      opts.id,
      profile.name,
      opts.cwd,
      profile.mock ?? {},
      profile.name,
      failTurn,
    );
  }
}
