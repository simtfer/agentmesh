/**
 * Stage-3 real verification: drive the LOCAL opencode and pi agents through the
 * full async task lifecycle (task_submit -> task_wait -> task_result) with the
 * 8-state machine and SQLite persistence, over the agentmesh acpxDriver.
 *
 * Uses a trivial prompt to keep cost minimal and a hard timeout so a hung
 * adapter cannot block forever. Agent output is treated as untrusted data.
 *
 * Run: npx tsx scripts/real-smoke.ts
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { TaskEvent } from "../src/types.js";

const ws = path.resolve(".smoke-ws");
mkdirSync(ws, { recursive: true });

const config = parseConfig({
  workdir: path.join(ws, ".agentmesh"),
  defaults: { permissionMode: "approve-reads" },
  profiles: [
    {
      name: "opencode-local",
      driver: "acpx",
      agent: "opencode-local",
      command: ["opencode", "acp"], // local install
      description: "OpenCode (local) over ACP",
    },
    {
      name: "pi-local",
      driver: "acpx",
      agent: "pi-local",
      command: ["npx", "-y", "pi-acp"], // pi-acp bridge -> local pi
      description: "Pi (local) over ACP bridge",
    },
  ],
});

const PROMPT = "Reply with exactly one word: OK. Do not call any tools.";
const HARD_TIMEOUT_MS = 120_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function trace(profile: string, ev: TaskEvent): void {
  if (ev.type === "output") {
    const kind = ev.data?.kind;
    if (kind === "tool" || kind === "status" || kind === "error") {
      process.stderr.write(`  [${profile}:${kind}] ${ev.text ?? ""}\n`);
    }
  } else if (ev.type === "waiting" || ev.type === "resumed") {
    process.stderr.write(`  [${profile}:${ev.type}] ${ev.text ?? ""}\n`);
  }
}

async function runOne(orch: Orchestrator, profile: string): Promise<boolean> {
  const started = Date.now();
  process.stdout.write(`\n=== ${profile} (async task lifecycle) ===\n`);
  try {
    // submit -> returns immediately with a taskId
    const sub = await withTimeout(
      Promise.resolve(orch.submitTask({ profile, prompt: PROMPT, cwd: ws, timeoutMs: HARD_TIMEOUT_MS }, { onEvent: (ev) => trace(profile, ev) })),
      10_000,
      `${profile}:submit`,
    );
    process.stdout.write(`  task_submit -> ${sub.taskId.slice(0, 8)} (${sub.status})\n`);

    // wait -> blocks until terminal (or the hard timeout)
    const rec = await withTimeout(orch.waitTask(sub.taskId, HARD_TIMEOUT_MS), HARD_TIMEOUT_MS + 5_000, `${profile}:wait`);
    const ms = Date.now() - started;

    // result -> final record from the store
    const res = orch.taskResult(sub.taskId);
    process.stdout.write(
      `  task_wait   -> ${rec?.status} (${ms}ms)\n  task_result -> ${res?.status} | worker=${res?.workerId}\n  text=${JSON.stringify((res?.text ?? "").slice(0, 200))}\n`,
    );
    if (res?.error) process.stdout.write(`  error=${res.error.message} (${res.error.code})\n`);

    // persistence: the event log must be queryable from the store
    const events = orch.taskEvents(sub.taskId);
    const kinds = events.map((e) => e.type);
    process.stdout.write(`  events      -> ${kinds.join(",")}\n`);

    return res?.status === "succeeded" && kinds.includes("completed");
  } catch (e) {
    process.stdout.write(`  FAILED: ${e instanceof Error ? e.message : String(e)}\n`);
    return false;
  }
}

const orch = new Orchestrator(config, { baseCwd: ws });
let okOpencode = false;
let okPi = false;
try {
  okOpencode = await runOne(orch, "opencode-local");
  okPi = await runOne(orch, "pi-local");
} finally {
  await orch.shutdown().catch(() => {});
}

process.stdout.write(
  `\n=== SUMMARY ===\nopencode: ${okOpencode ? "PASS" : "FAIL"}\npi: ${okPi ? "PASS" : "FAIL"}\n`,
);
process.exit(okOpencode || okPi ? 0 : 1);
