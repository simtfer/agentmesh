# agentmesh

A **protocol-native adapter** that lets one coding agent act as a **master** and
command a pool of **heterogeneous worker agents** (OpenCode, Pi, Codex, Gemini,
Claude Code, …). Roles are decided by *configuration*, not by agent type — so an
OpenCode master can drive Pi workers, a Pi master can drive OpenCode workers, or
anything else, with the same code.

```
┌─────────────┐   MCP tools    ┌──────────────────────────┐   ACP (JSON-RPC/stdio)   ┌──────────────┐
│ master agent │ ─────────────▶ │ agentmesh adapter        │ ───────────────────────▶ │ worker: pi   │
│ (opencode/pi)│  spawn/dispatch│  • MCP server (in)       │   via acpx runtime       ├──────────────┤
│  ...any MCP  │ ◀───────────── │  • Orchestrator          │ ◀─────────────────────── │ worker:      │
│    client    │   results      │  • Worker registry       │   streamed events        │   opencode   │
└─────────────┘                │  • git-worktree isolation│                          ├──────────────┤
                               └──────────────────────────┘                          │ worker: ...  │
                                                                                      └──────────────┘
```

## Why this shape

Two protocols do the heavy lifting, so we don't reinvent either:

- **ACP (Agent Client Protocol)** — Zed's open JSON-RPC-over-stdio protocol for
  driving coding agents. OpenCode (`opencode acp`), Pi (`npx pi-acp`), Gemini,
  Codex, Claude Code, Cursor, Qwen and more all speak it. We reuse
  [`acpx`](https://github.com/openclaw/acpx) as the ACP client, so **one
  integration drives every worker**.
- **MCP (Model Context Protocol)** — how the master gains orchestration
  superpowers. The adapter exposes tools (`spawn_worker`, `dispatch_task`, …);
  any MCP-capable agent that connects becomes a master **with zero changes to
  itself**. Pi 1.0 and OpenCode both support MCP.

This is deliberately lighter than agent-orchestrator IDEs (Electron/GUI) and
tmux-screen-scraping supervisors: the master stays a normal agent, workers stay
normal agents, and the adapter is just the protocol bridge + lifecycle manager
between them.

## Status

Working and verified end-to-end: an **8-state persistent task machine** (SQLite),
**async task lifecycle** (`task_submit` / `task_wait` / `task_result` / …), and a
**human-in-the-loop approval flow** for worker permission/elicitation requests —
driven against **real local OpenCode and Pi agents** as well as deterministic
mocks. See [Verification](#verification).

## Install

```bash
cd agentmesh
npm install
```

Requires Node.js ≥ 22.13. Real workers additionally require the upstream CLI
(`pi`, `opencode`, …) installed and authenticated on the machine.

## Try it (no API keys, no cost)

```bash
npm run demo     # Scene A: sync delegate-and-wait; Scene B: submit→waiting→approve→succeeded
npm test         # 15 unit tests: state machine, persistence, timeout, cancel, approvals
npm run smoke    # drives the real MCP server over stdio through the full task lifecycle
```

`demo` ends with `Scene A CLOSED ✅ | Scene B CLOSED ✅` — the master→worker→result
round trip plus the async approval loop.

To exercise the **real** agents on this machine (trivial prompt, minimal cost):

```bash
npx tsx scripts/real-smoke.ts   # opencode + pi through submit → wait → result
```

## Configuration — `agentmesh.yaml`

Everything under `profiles` describes **workers** the master can spawn.

```yaml
workdir: .agentmesh          # worktrees + acpx session state
defaults:
  permissionMode: approve-all # deny-all | approve-reads | approve-all

profiles:
  - name: mock-analyst        # deterministic, offline
    driver: mock
    mock: { delayMs: 20, toolCalls: 2 }

  - name: pi                  # real Pi worker over ACP
    driver: acpx
    agent: pi                 # acpx built-in -> `npx pi-acp`
    worktree: true            # isolate parallel edits

  - name: opencode            # real OpenCode worker over ACP
    driver: acpx
    agent: opencode           # acpx built-in -> `npx -y opencode-ai acp`
    worktree: true

  # custom launch command + model:
  # - name: opencode-sonnet
  #   driver: acpx
  #   agent: opencode-custom
  #   command: ["npx", "-y", "opencode-ai", "acp"]
  #   model: anthropic/claude-sonnet-4-5
```

`agent` can be any acpx built-in name (`pi`, `opencode`, `codex`, `claude`,
`gemini`, `cursor`, `qwen`, `qoder`, …) or a custom key paired with `command`.

## Task lifecycle & the 8-state machine

Every delegation is a **task** that moves through a persistent state machine:

```
queued ─▶ starting ─▶ running ─▶ succeeded
                        │  ▲
                 waiting│  │ (approve / respond)
                        ▼  │
                       (loops back to running)
   running/waiting ─▶ failed | cancelled | timed_out   (terminal)
```

Terminal states: `succeeded`, `failed`, `cancelled`, `timed_out`. Tasks and their
event logs are persisted to **SQLite** (`node:sqlite`, no native deps) under
`workdir`, so a task submitted by one process can be queried by the next.

Two ways to delegate:

- **Async (primary):** `task_submit` returns a `taskId` immediately. Poll
  `task_status`, block on `task_wait`, read `task_result`, or page `task_events`.
  `task_wait` also returns as soon as a task enters `waiting` so the master can
  act on an approval instead of blocking to the timeout.
- **Sync (convenience):** `dispatch_task` submits and waits for the terminal
  result in one call.

### Approvals (human-in-the-loop)

When a worker hits a risky tool (ACP permission request) or asks for input (ACP
elicitation), its task moves to `waiting` and blocks. The master then:

1. `pending_approvals { taskId? }` → lists blocking requests (`kind`, `id`).
2. `task_approve { approvalId, decision }` → `allow_once | allow_always |
   reject_once | reject_always | cancel`, **or**
   `task_respond { approvalId, action, content? }` → answer an elicitation.

Approving resumes the task synchronously back to `running`; rejecting fails it.
Cancelling or timing out a task auto-resolves its pending approvals.

> **Security:** worker output and permission requests are **untrusted data**, never
> instructions. Keep `permissionMode` at `approve-reads`/`deny-all` for untrusted
> work, require human approval for irreversible operations, and never commit
> secrets or expose the ACP bridge to a network without auth + TLS.

## MCP tools exposed to the master

| tool | purpose |
|---|---|
| `agent_list` | configured worker profiles + live workers |
| `agent_inspect` | one worker's status + recent event log |
| `spawn_worker` | start a worker (optionally in a git worktree) |
| `kill_worker` | close a worker and clean its worktree |
| `task_submit` | **submit a task, return a `taskId` immediately** (primary async call) |
| `task_status` | current status of a task |
| `task_wait` | block until terminal **or** `waiting` (needs approval) |
| `task_result` | final text / status / error of a task |
| `task_events` | persisted event log after a sequence number |
| `task_cancel` | request cancellation (settles once the worker confirms) |
| `list_tasks` | list tasks, optionally filtered by status |
| `pending_approvals` | approval/elicitation requests blocking a `waiting` task |
| `task_approve` | resolve a permission request (allow/deny/cancel) |
| `task_respond` | answer an elicitation request |
| `dispatch_task` | synchronous convenience: submit + wait for the terminal result |

## Attach a real master

Build, then point your master agent's MCP config at the server. The command is
always: `node <abs>/dist/cli.js mcp --config <abs>/agentmesh.yaml`.

```bash
npm run build
```

**OpenCode** (`opencode.json` / `~/.config/opencode/opencode.json`) — shape:

```json
{
  "mcp": {
    "agentmesh": {
      "type": "local",
      "command": ["node", "/ABS/PATH/agentmesh/dist/cli.js", "mcp", "--config", "/ABS/PATH/agentmesh/agentmesh.yaml"],
      "enabled": true
    }
  }
}
```

**Pi** (`.pi/settings.json` or `~/.pi/agent/settings.json`) — Pi 1.0 has native
MCP; add agentmesh as a local/stdio MCP server with the same command.

> Verify the exact MCP-server config keys against the current OpenCode/Pi docs —
> the command line above is what matters and is stable.

Then just talk to your master: *"spawn an opencode worker to fix the failing
tests while a pi worker writes the changelog."* It will call `dispatch_task`.

## CLI

```bash
npx tsx src/cli.ts demo
npx tsx src/cli.ts list     --config agentmesh.yaml
npx tsx src/cli.ts mcp      --config agentmesh.yaml

# synchronous delegate-and-wait
npx tsx src/cli.ts dispatch --profile pi --task "fix the auth bug" --worktree

# async task lifecycle (persisted to SQLite)
npx tsx src/cli.ts submit   --profile pi --prompt "fix the auth bug"   # prints taskId
npx tsx src/cli.ts tasks    --config agentmesh.yaml
npx tsx src/cli.ts approve  --approval-id A --decision allow_once
```

> Note: `submit` from the one-shot CLI persists the task but its live run ends
> with the process. For real async use, submit through the long-lived `mcp`
> server (or a resident orchestrator) so the run continues in the background.

## Architecture

```
src/
  types.ts             domain types (WorkerProfile, TaskRecord, TaskStatus, TaskEvent, ...)
  config.ts            YAML load + zod validation
  statemachine.ts      8-state transitions + terminal/legality guards
  worktree.ts          git-worktree isolation for parallel workers
  registry.ts          worker lifecycle + bounded event log
  approvals.ts         ApprovalBroker: bridges permission/elicitation to the master
  tasks.ts             TaskManager: async 8-state lifecycle, timeout/cancel, approvals
  store/
    memory.ts          in-memory TaskStore (tests, persist:false)
    sqlite.ts          durable TaskStore on node:sqlite (default)
  orchestrator.ts      the core facade: workers + tasks + store + drivers
  drivers/
    factory.ts         picks a driver per profile (acpx lazily constructed)
    acpxDriver.ts      real ACP workers via acpx runtime (+ permission/elicitation hooks)
    mockDriver.ts      deterministic offline worker (demo/tests, incl. requireApproval)
  mcp/server.ts        exposes the orchestrator as 15 MCP tools over stdio
  cli.ts               demo | list | mcp | dispatch | submit | tasks
```

**Role symmetry:** nothing in the code says "opencode is master". The master is
whoever has the MCP server attached; workers are whoever the adapter drives.
Swap the two and it still works.

## Verification

Checked on this machine (Node v26, Windows):

- `tsc --noEmit` — clean.
- `npm test` — **15/15** pass: happy path, worker failure, `timeout → timed_out`,
  `cancel → cancelled`, `waiting → approve → succeeded`, `reject → failed`,
  idempotency de-dup, SQLite restart-and-requery, and store column-merge safety.
- `npm run demo` — Scene A (sync dispatch to two workers) and Scene B
  (submit → waiting → approve → succeeded) both close.
- `npm run smoke` — real MCP stdio server through the full lifecycle; event
  sequence `accepted, started, output…, waiting, resumed, output…, completed`.
- `scripts/real-smoke.ts` — **real local OpenCode and Pi** driven through
  `task_submit → task_wait → task_result`; both return `OK`, reach `succeeded`,
  and persist their tasks + events to SQLite (2 tasks / 27 events observed).

## Roadmap

Done:

- ✅ Async task lifecycle with an 8-state machine + SQLite persistence.
- ✅ Human-in-the-loop approvals (permission + elicitation) via the broker.
- ✅ Real ACP workers (OpenCode, Pi) verified end-to-end.

Next:

- Parallel fan-out across concurrent workers + a real queue owner.
- Master-side prompt/skill pack so the master delegates well by default.
- Cross-worker handoff (pipe one worker's diff into another's context).
- Remote Worker Daemon: run workers on other machines over an authenticated,
  TLS-protected channel (never expose a raw ACP stdio bridge to the LAN).
- Structured result contracts (JSON output schema per task) + cost/usage roll-up
  from ACP `usage_update` events.
- Recursion guard: cap delegation depth to prevent infinite master↔worker loops.

## License

MIT
