# agentmesh

**English** · [简体中文](README.zh.md)

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

[![CI](https://github.com/simtfer/agentmesh/actions/workflows/ci.yml/badge.svg)](https://github.com/simtfer/agentmesh/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-brightgreen.svg)](package.json)

126 offline tests on Linux and Windows · not published to npm yet

## What this is

Two protocols do the heavy lifting, so we don't reinvent either:

- **ACP (Agent Client Protocol)** — Zed's open JSON-RPC-over-stdio protocol for
  driving coding agents. OpenCode (`opencode acp`), Pi (`npx pi-acp`), Gemini,
  Codex, Claude Code, Cursor, Qwen and more all speak it. We reuse
  [`acpx`](https://github.com/openclaw/acpx) as the ACP client, so **one
  integration drives every worker**.
- **MCP (Model Context Protocol)** — how the master gains orchestration
  superpowers. The adapter exposes tools (`spawn_worker`, `dispatch_task`, …);
  any MCP-capable agent that connects becomes a master **with zero changes to
  itself**.

This is deliberately lighter than agent-orchestrator IDEs (Electron/GUI) and
tmux-screen-scraping supervisors: the master stays a normal agent, workers stay
normal agents, and the adapter is just the protocol bridge + lifecycle manager
between them.

What it is **not** — so nobody adopts it for the wrong job:

- **Not an agent IDE or GUI.** No desktop app, no chat pane, no visual canvas. The
  master is the agent you already use.
- **Not an agent framework.** It defines no agent loop, prompt format, or model
  abstraction; it drives agents that already exist and speak ACP.
- **Not a workflow engine.** Tasks are flat. `dependsOn` gates them into a static
  DAG — no cycles, no conditionals, no loops, no DSL. Cross-task *artifacts* still
  travel only through an explicit `handoff`.
- **Not a sandbox.** Isolation is git worktrees plus permission modes; it does not
  containerise or otherwise confine worker processes.

## Quick start

agentmesh is **not published to npm yet** — install from source:

```bash
git clone https://github.com/simtfer/agentmesh.git
cd agentmesh
npm install
```

Then run it with no API keys and no cost:

```bash
npm run demo     # Scene A: sync delegate-and-wait; Scene B: submit→waiting→approve→succeeded
npm test         # full offline suite (mocks; no network, no API cost)
npm run smoke    # drives the real MCP server over stdio through the full task lifecycle
```

`demo` ends with `Scene A CLOSED ✅ | Scene B CLOSED ✅` — the master→worker→result
round trip plus the async approval loop. To exercise the **real** agents on this
machine (trivial prompt, minimal cost), run `npm run real` — `opencode` and `pi`
both need to be installed and authenticated.

## Connect a master

Build, then point your master agent's MCP config at the server:

```bash
npm run build
```

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

That is an OpenCode-style entry; Pi 1.0 takes the same command as a local/stdio
MCP server. Then just talk to your master: *"spawn an opencode worker to fix the
failing tests while a pi worker writes the changelog."* — it calls `dispatch_task`.

Per-client snippets and every CLI command: [`docs/cli.md`](docs/cli.md).

## Core concepts

Every delegation is a **task** in an 8-state persistent machine, stored in SQLite
under `workdir` — so a task submitted by one process can be queried by the next:

```
queued ─▶ starting ─▶ running ─▶ succeeded
                        │  ▲
                 waiting│  │ (approve / respond)
                        ▼  │
   queued (no slot, TTL/deadline hit) ─▶ timed_out         (terminal)
   starting/running/waiting ─▶ queued        (retry: another attempt is due)
   running/waiting ─▶ failed | cancelled | timed_out   (terminal)
```

- **Async is the primary mode.** `task_submit` returns a `taskId` immediately;
  poll `task_status`, block on `task_wait`, read `task_result`, page
  `task_events`. `dispatch_task` is the synchronous convenience wrapper.
- **Approvals are a first-class state.** When a worker hits a risky tool or asks
  for input, the task moves to `waiting` and `task_wait` returns early; the master
  answers with `task_approve` / `task_respond`.
- **Worker output is untrusted data**, never instructions — including everything
  that arrives through a handoff.

Full transition rules and the approval loop: [`docs/lifecycle.md`](docs/lifecycle.md).

## Configuration

`agentmesh.yaml` describes the **workers**; the master is whatever connects.

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
    agent: opencode
    worktree: true
```

`agent` can be any acpx built-in name (`pi`, `opencode`, `codex`, `claude`,
`gemini`, `cursor`, `qwen`, `qoder`, …) or a custom key paired with `command`.
Every key — profiles, `limits`, `daemon` — is documented in
[`docs/configuration.md`](docs/configuration.md).

## MCP tools

Eighteen tools over stdio. The core loop:

| group | tools |
|---|---|
| Workers | `agent_list` · `agent_inspect` · `spawn_worker` · `kill_worker` |
| Tasks | `task_submit` · `task_status` · `task_wait` · `task_result` · `task_events` · `task_cancel` · `list_tasks` |
| Operations | `scheduler_status` · `usage_summary` · `pending_approvals` · `task_approve` · `task_respond` |
| Convenience | `dispatch_task` · `master_playbook` |

`master_playbook` serves the **self-hosted delegation guide** (the same content as
`skills/agentmesh-master/SKILL.md`, also browsable as
`agentmesh://skills/master/en|zh`), so the guidance travels with the server
instead of being pasted into each agent's config. Full signatures:
[`docs/mcp-tools.md`](docs/mcp-tools.md).

## Going further

**Cross-worker handoff** — chain B onto a finished A: `inject: "result"` inlines
A's text under an untrusted envelope, `inject: "diff"` writes a redacted patch
sidecar (and, for a remote worker, ships the patch with the submit so the daemon
stages it locally), `base: "predecessor"` starts B's worktree from A's end state
— that last one stays same-host, since a commit is not bytes.
[`docs/handoff.md`](docs/handoff.md)

**Structured results and cost** — `outputSchema` enforces a JSON contract
(violations fail the task; the parsed value returns in `structured`), while ACP
`usage_update` feeds a per-task and aggregate token/cost roll-up.
[`docs/contracts.md`](docs/contracts.md)

**Advanced scheduling** — `dependsOn` gates a task behind others, `retry` re-runs
transient failures with backoff, `deadlineMs` bounds queue wait *and* execution,
and profile `weight` turns the queue into weighted fair queueing.
[`docs/limits.md`](docs/limits.md)

**Remote workers** — a `driver: remote` profile talks WSS + Bearer token to a
daemon that wraps the same core, so ACP stdio never crosses the network. Tokens
come from the environment, non-loopback binds require TLS, `daemon.tls.ca` enables
mTLS, `allowCwd` whitelists paths, a dropped connection reconciles to `cancelled`,
and every decision lands in a size-rotated NDJSON audit log.
[`docs/remote.md`](docs/remote.md) · runbook [`docs/deploy.md`](docs/deploy.md)

## Safety and limits

These guards apply to every deployment, local or remote:

- **Recursion guard** — `limits.maxDelegationDepth` (default 8), inherited across
  processes through `$AGENTMESH_DELEGATION_DEPTH`; a submit at the cap fails
  without spawning a worker.
- **Back-pressure by default** — with `maxQueuedTasks: 0` an over-cap submit is
  refused (`concurrency_limit_exceeded`) instead of queued; set it higher for real
  scheduling.
- **Shelf life** — `queueTtlMs` bounds queue wait, `deadlineMs`/`deadlineAt` bound
  the whole task, and a deadline already past at submit time is refused outright.
- **Spend ceilings** — per-task `budget { maxTokens, maxCost }` aborts mid-turn and
  is never retried; process-wide `maxTotalTokens`/`maxTotalCost` refuse *new*
  submits while accepted work finishes.
- **Approval width** — past `limits.maxWaitingTasks`, permission requests are
  denied on the spot rather than parked.
- **Bounded output** — `maxOutputBytes` truncates on a UTF-8 boundary and flags
  `outputTruncated`, so a runaway agent cannot bloat the store.

Every cap, its default, and what happens when it fires:
[`docs/limits.md`](docs/limits.md).

## Troubleshooting

Every failure lands on the task record (`error.code`) *and* the event log, so
`task_result` / `task_events` tell you **why**, not just that it failed.

| `error.code` | What to do |
|---|---|
| `concurrency_limit_exceeded` | retry after a slot frees, or set `maxQueuedTasks > 0` |
| `budget_exceeded` | raise the task's ceiling or split the work; it is never retried |
| `handoff_artifact_unavailable` | run the successor locally, or use `inject: "result"` |
| `output_schema_invalid` | read `metadata.outputContract.errors` for the offending paths |

A task stuck in `waiting` is blocked on an approval, and `dispatch_task` cannot
advance it — use `task_submit` + `task_wait`. The other 16 codes, plus the
non-error symptoms (daemon 401s, TLS failures):
[`docs/troubleshooting.md`](docs/troubleshooting.md).

## Docs

| | |
|---|---|
| [`configuration.md`](docs/configuration.md) | every key in `agentmesh.yaml` |
| [`cli.md`](docs/cli.md) | commands + attaching OpenCode / Pi |
| [`lifecycle.md`](docs/lifecycle.md) | 8 states, delegating modes, approvals |
| [`mcp-tools.md`](docs/mcp-tools.md) | the 18 tools + the self-hosted playbook |
| [`handoff.md`](docs/handoff.md) | chaining tasks onto a predecessor's output |
| [`contracts.md`](docs/contracts.md) | JSON result contracts, usage/cost roll-up |
| [`limits.md`](docs/limits.md) | scheduler, retries, budgets, safety guards |
| [`troubleshooting.md`](docs/troubleshooting.md) | error codes and symptoms |
| [`remote.md`](docs/remote.md) | the Remote Worker Daemon in full |
| [`deploy.md`](docs/deploy.md) | two-host runbook: CA, mTLS, firewall, boot |
| [`architecture.md`](docs/architecture.md) | layers, source map, role symmetry |
| [`verification.md`](docs/verification.md) | test-by-test coverage and known gaps |
| [`PLAN.md`](docs/PLAN.md) | design notes, rejected alternatives, roadmap |

## Verification

```bash
npm run typecheck   # tsc --noEmit, clean
npm test            # 126 tests, offline, no API cost, ~26s
npm run demo        # Scene A + Scene B both close
npm run smoke       # real MCP server over stdio through the full lifecycle
npm run check:pack  # publish tarball contains dist/, and no sources or tests
npm run deploy:tls  # real TLS/mTLS run over this host's LAN interface (not loopback)
npm run real        # real local opencode + pi (both must be installed & authenticated)
```

`npm test` is **126/126** across ten files, offline, in about 26 seconds. Every
case drives a public surface (Orchestrator, MCP tools, or the daemon's HTTP/WS
endpoints) and asserts the resulting task record, not a mock's internal calls.
CI runs the same gate on Linux and Windows × Node 22 and 24
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)); real OpenCode and Pi
workers have also been driven end-to-end. Per-case breakdown and what is **not**
covered yet: [`docs/verification.md`](docs/verification.md).

## Roadmap

Working today: async 8-state lifecycle on SQLite, human-in-the-loop approvals,
real ACP workers, bounded weighted-fair scheduling with deadlines and DAG retries,
cross-worker handoff (including a diff handed to a worker on another host),
enforced JSON contracts with cost roll-up, hard spend budgets, a self-hosted
playbook, and a remote daemon with mutual TLS.

Next:

- **Optional web console** — the audit trail and `scheduler_status` already expose
  the data a read-only view would render.

## Contributing

```bash
npm run typecheck && npm test && npm run build && npm run demo
```

That four-command gate is what every change is expected to pass; `npm run smoke`
too when the MCP surface moves. CI runs it on Linux and Windows, so that gate is
enforced rather than remembered. New tests are `node:test` files driving a public
interface (orchestrator, MCP tools, daemon HTTP/WS) and asserting the task record
— never a mock's internals — and each new file must be added to the explicit list
in `package.json#scripts.test`. Documentation is bilingual: `README.md` and
`README.zh.md` must stay structurally identical, and the deep docs live in
`docs/`.

## License

MIT
