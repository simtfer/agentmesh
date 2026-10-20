#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { loadConfig, parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { runMcpServer } from "./mcp/server.js";
import { WorkerDaemon } from "./remote/daemon.js";
import { runTeamCommand } from "./team/cli.js";
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
  host?: string;
  port?: number;
  tokenEnv?: string;
  tlsCert?: string;
  tlsKey?: string;
  tlsCa?: string;
  allowInsecure?: boolean;
  orphanGraceMs?: number;
  url?: string;
  limit?: number;
  follow?: boolean;
  wait?: boolean;
  content?: string;
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
      case "--host": out.host = next(); break;
      case "--port": out.port = Number(next()); break;
      case "--token-env": out.tokenEnv = next(); break;
      case "--tls-cert": out.tlsCert = next(); break;
      case "--tls-key": out.tlsKey = next(); break;
      case "--tls-ca": out.tlsCa = next(); break;
      case "--orphan-grace-ms": out.orphanGraceMs = Number(next()); break;
      case "--url": out.url = next(); break;
      case "--limit": out.limit = Number(next()); break;
      case "--follow": out.follow = true; break;
      case "--wait": out.wait = true; break;
      case "--content": out.content = next(); break;
      case "--worktree": out.worktree = true; break;
      case "--allow-insecure": out.allowInsecure = true; break;
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
  # approvals are answered through the MCP surface (task_approve): a pending
  # approval lives in the orchestrator that owns the run, so a one-shot CLI
  # process cannot answer one.

  # remote worker daemon (run on the worker host; ACP stdio never crosses the wire)
  agentmesh daemon [--config f] [--host h] [--port p]
                   [--token-env VAR[,VAR2]] [--tls-cert c --tls-key k [--tls-ca ca]]
                   [--orphan-grace-ms N] [--allow-insecure]
    token is read from the env var(s) named by --token-env / daemon.tokenEnv
    (never from config). Pass several comma-separated names — or several
    comma-separated values in one var — to accept multiple valid tokens during a
    rotation; send SIGHUP to re-read them from the environment with no downtime.
    Non-loopback binds require TLS unless --allow-insecure.
    --orphan-grace-ms keeps a dropped task alive N ms so a client can re-attach
    and resume its stream (default 0 = cancel immediately, no orphans).

  # a team of named members in shared rooms (see docs/team.md)
  agentmesh team serve [--config f] [--host h] [--port p] [--token-env VAR]
  agentmesh team chat                     group chat + DMs against a running team
  agentmesh team say <channel> "text" [--wait]
  agentmesh team dm <member> "text" [--wait]
  agentmesh team log [channel] [--limit N] [--follow]
  agentmesh team members | channels | status
  agentmesh team transcript <member>       what that member actually did
  agentmesh team approve <approvalId> <decision>
  agentmesh team respond <approvalId> <accept|decline|cancel> [--content json]

Roles are config-driven: any MCP-capable agent (opencode, pi, ...) can be the
master; workers are driven over ACP via acpx, locally or on a remote daemon.

A team runs on top of those workers: each member is a pinned worker session
with its own workspace and memory, and @mentions in a channel are what hand a
turn from one member to the next.
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

async function cmdDaemon(args: Args): Promise<void> {
  const cfg = await resolveConfig(args);
  const orch = new Orchestrator(cfg, { baseCwd: process.cwd() });
  const daemon = new WorkerDaemon({
    config: cfg,
    orchestrator: orch,
    host: args.host ?? cfg.daemon?.host,
    port: args.port ?? cfg.daemon?.port,
    tokenEnv: args.tokenEnv ?? cfg.daemon?.tokenEnv,
    allowCwd: cfg.daemon?.allowCwd,
    tls:
      args.tlsCert && args.tlsKey
        ? { cert: args.tlsCert, key: args.tlsKey, ca: args.tlsCa }
        : cfg.daemon?.tls,
    allowInsecure: args.allowInsecure,
    orphanGraceMs: args.orphanGraceMs ?? cfg.daemon?.orphanGraceMs,
  });

  const info = await daemon.start();
  const scheme = info.url.startsWith("https") ? "https" : "http";
  process.stderr.write(
    `[agentmesh] worker daemon listening on ${info.url} (${scheme}, profiles: ${cfg.profiles
      .filter((p) => p.driver !== "remote")
      .map((p) => p.name)
      .join(", ") || "none"})\n`,
  );
  if (scheme === "http" && !args.allowInsecure) {
    process.stderr.write(
      `[agentmesh] note: plain HTTP — bind is loopback-only. Use --tls-cert/--tls-key for remote hosts.\n`,
    );
  }

  const shutdown = async (sig: string) => {
    process.stderr.write(`[agentmesh] ${sig} — shutting down daemon\n`);
    await daemon.stop().catch(() => {});
    await orch.shutdown().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Zero-downtime credential rotation: re-read accepted tokens from the
  // environment on SIGHUP. Add a new secret alongside the old, migrate clients,
  // then `kill -HUP <pid>` and drop the old env var. Failures are non-fatal —
  // the daemon keeps serving with the previously-accepted tokens.
  process.on("SIGHUP", () => {
    try {
      const n = daemon.reloadTokens();
      process.stderr.write(`[agentmesh] SIGHUP — reloaded bearer tokens (${n} accepted)\n`);
    } catch (e) {
      process.stderr.write(
        `[agentmesh] SIGHUP — token reload failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  });
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
    case "daemon": return cmdDaemon(args);
    case "team":
      return runTeamCommand(
        {
          sub: args._[1],
          rest: args._.slice(2),
          url: args.url,
          tokenEnv: args.tokenEnv,
          limit: args.limit,
          follow: args.follow,
          wait: args.wait,
          host: args.host,
          port: args.port,
          content: args.content,
        },
        () => resolveConfig(args),
      );
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
