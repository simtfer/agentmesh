#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { loadConfig, parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { runMcpServer } from "./mcp/server.js";
import type { MeshConfig, TaskEvent, PermissionDecision } from "./types.js";

interface Args {
  _: string[];
  config?: string;
  profile?: string;
  task?: string;
  prompt?: string;
  cwd?: string;
  worktree?: boolean;
  workerId?: string;
  taskId?: string;
  approvalId?: string;
  decision?: string;
  timeout?: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i]!;
    switch (a) {
      case "--config": out.config = next(); break;
      case "--profile": out.profile = next(); break;
      case "--task": out.task = next(); break;
      case "--prompt": out.prompt = next(); break;
      case "--cwd": out.cwd = next(); break;
      case "--worker-id": out.workerId = next(); break;
      case "--task-id": out.taskId = next(); break;
      case "--approval-id": out.approvalId = next(); break;
      case "--decision": out.decision = next(); break;
      case "--timeout": out.timeout = Number(next()); break;
      case "--worktree": out.worktree = true; break;
      default:
        if (a.startsWith("--")) { const [k, v] = a.slice(2).split("="); (out as unknown as Record<string, unknown>)[k!] = v ?? true; }
        else out._.push(a);
    }
  }
  return out;
}

async function resolveConfig(args: Args): Promise<MeshConfig> {
  const p = path.resolve(args.config ?? "agentmesh.yaml");
  if (existsSync(p)) return loadConfig(p);
  throw new Error(`config not found: ${p} (pass --config <file>)`);
}

/** Embedded mock config so `demo` runs anywhere with zero setup. */
const DEMO_CONFIG: MeshConfig = parseConfig({
  workdir: ".agentmesh",
  profiles: [
    { name: "analyst", driver: "mock", description: "research/analysis (mock)", mock: { delayMs: 20, toolCalls: 2 } },
    { name: "implementer", driver: "mock", description: "code-writing (mock)", mock: { delayMs: 20, toolCalls: 3 } },
    { name: "approver", driver: "mock", description: "asks permission first (mock)", mock: { delayMs: 10, requireApproval: true } },
  ],
});

const HELP = `agentmesh — protocol-native master/worker agent adapter

Usage:
  agentmesh demo                          self-contained mock delegation + approval loop
  agentmesh list    [--config f]          list configured worker profiles
  agentmesh mcp     [--config f]          start the MCP server on stdio (attach a master)

  # synchronous delegate-and-wait
  agentmesh dispatch --profile P --task "..." [--cwd d] [--worktree] [--config f]

  # async task lifecycle (8-state machine, persisted to SQLite)
  agentmesh submit --profile P --prompt "..." [--config f]     -> prints taskId
  agentmesh tasks  [--config f]                                -> list tasks
  agentmesh status --task-id T [--config f]
  agentmesh wait   --task-id T [--timeout ms] [--config f]
  agentmesh approve --approval-id A --decision allow_once [--config f]

Roles are config-driven: any MCP-capable agent (opencode, pi, ...) can be the
master; workers are driven over ACP via acpx.
`;

const traceLine = (id: string, ev: TaskEvent) => {
  if (ev.type === "output" && (ev.data?.kind === "tool" || ev.data?.kind === "text")) {
    process.stdout.write(`   [${id}] ${ev.data?.kind}: ${ev.text}\n`);
  } else if (ev.type === "waiting" || ev.type === "resumed") {
    process.stdout.write(`   [${id}] ${ev.type}: ${ev.text}\n`);
  }
};

async function cmdDemo(): Promise<void> {
  const orch = new Orchestrator(DEMO_CONFIG, { baseCwd: process.cwd(), persist: false });
  const line = (s: string) => process.stdout.write(s + "\n");

  line("=== agentmesh demo ===");
  line("(deterministic mock workers — no API keys, no cost)\n");

  // --- Scene A: synchronous delegate-and-wait closed loop ---
  line("--- Scene A: master delegates to two workers (dispatch = submit+wait) ---");
  const goal = "Add a /health endpoint and document it";
  line(`[master] goal: ${goal}`);
  const subtasks = [
    { profile: "analyst", task: "Find where HTTP routes are registered." },
    { profile: "implementer", task: "Implement GET /health and add a docs section." },
  ];
  const results = [];
  for (const st of subtasks) {
    line(`\n[master] dispatch -> ${st.profile}: ${st.task}`);
    const res = await orch.dispatch({
      profile: st.profile,
      task: st.task,
      onEvent: (ev) => traceLine(st.profile, ev),
    });
    line(`   => ${res.status}: ${res.text}`);
    results.push(res);
  }

  // --- Scene B: async task + waiting/approval ---
  line("\n--- Scene B: async submit -> waiting -> approve -> succeeded ---");
  const submitted = orch.submitTask({ profile: "approver", prompt: "refactor the risky module" });
  line(`[master] task_submit -> ${submitted.taskId} (${submitted.status})`);

  // wait a tick so the worker reaches the permission request
  let rec = await orch.waitTask(submitted.taskId, 50);
  while (rec && rec.status !== "waiting" && !["succeeded", "failed", "cancelled", "timed_out"].includes(rec.status)) {
    await new Promise((r) => setTimeout(r, 20));
    rec = orch.taskStatus(submitted.taskId);
  }
  line(`[master] task_status -> ${rec?.status}${rec?.waitingReason ? ` (${rec.waitingReason})` : ""}`);

  const pending = orch.pendingApprovals(submitted.taskId);
  if (pending[0]) {
    line(`[master] pending_approvals -> ${pending[0].id} [${pending[0].kind}]`);
    orch.approveTask(pending[0].id, "allow_once" as PermissionDecision);
    line(`[master] task_approve -> allow_once`);
  }

  const final = await orch.waitTask(submitted.taskId, 5000);
  line(`[master] task_result -> ${final?.status}: ${(final?.text ?? "").slice(0, 80)}`);

  const okA = results.every((r) => r.status === "completed");
  const okB = final?.status === "succeeded";
  line(`\n[master] Scene A ${okA ? "CLOSED ✅" : "INCOMPLETE ❌"} | Scene B ${okB ? "CLOSED ✅" : "INCOMPLETE ❌"}`);

  await orch.shutdown();
  if (!okA || !okB) process.exitCode = 1;
}

async function cmdList(args: Args): Promise<void> {
  const cfg = await resolveConfig(args);
  const orch = new Orchestrator(cfg, { baseCwd: process.cwd() });
  process.stdout.write(JSON.stringify({ profiles: orch.listProfiles() }, null, 2) + "\n");
  await orch.shutdown();
}

async function cmdDispatch(args: Args): Promise<void> {
  if (!args.task) throw new Error("dispatch requires --task");
  const cfg = await resolveConfig(args);
  const orch = new Orchestrator(cfg, { baseCwd: process.cwd() });
  const res = await orch.dispatch({
    task: args.task, profile: args.profile, workerId: args.workerId,
    cwd: args.cwd, worktree: args.worktree,
    onEvent: (ev) => { if (ev.type === "output" && ev.data?.kind !== "text") process.stderr.write(`[${ev.data?.kind ?? ev.type}] ${ev.text ?? ""}\n`); },
  });
  process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  await orch.shutdown();
  if (res.status !== "completed") process.exitCode = 1;
}

async function cmdSubmit(args: Args): Promise<void> {
  const prompt = args.prompt ?? args.task;
  if (!prompt) throw new Error("submit requires --prompt");
  const cfg = await resolveConfig(args);
  const orch = new Orchestrator(cfg, { baseCwd: process.cwd() });
  const rec = orch.submitTask({ prompt, profile: args.profile, workerId: args.workerId, cwd: args.cwd, worktree: args.worktree, timeoutMs: args.timeout });
  process.stdout.write(JSON.stringify({ taskId: rec.taskId, status: rec.status }, null, 2) + "\n");
  // NOTE: submitting then exiting ends the process; the task is persisted but its
  // live run stops with this process. Use `mcp`/long-lived mode for real async use.
  await orch.shutdown();
}

async function cmdTasks(args: Args): Promise<void> {
  const cfg = await resolveConfig(args);
  const orch = new Orchestrator(cfg, { baseCwd: process.cwd() });
  const tasks = orch.listTasks({ limit: 50 }).map((t) => ({
    taskId: t.taskId, profile: t.profile, status: t.status, createdAt: t.createdAt,
  }));
  process.stdout.write(JSON.stringify({ tasks }, null, 2) + "\n");
  await orch.shutdown();
}

async function cmdMcp(args: Args): Promise<void> {
  const cfg = await resolveConfig(args);
  const orch = new Orchestrator(cfg, { baseCwd: process.cwd() });
  await runMcpServer(orch);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args._[0]) {
    case "demo": return cmdDemo();
    case "list": return cmdList(args);
    case "dispatch": return cmdDispatch(args);
    case "submit": return cmdSubmit(args);
    case "tasks": return cmdTasks(args);
    case "mcp": return cmdMcp(args);
    case undefined: case "help": case "--help":
      process.stdout.write(HELP); return;
    default:
      process.stdout.write(HELP); process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`[agentmesh] error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
