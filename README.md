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

## Contents

- [Why this shape](#why-this-shape)
- [Status](#status)
- [Install](#install)
- [Try it (no API keys, no cost)](#try-it-no-api-keys-no-cost)
- [Configuration](#configuration)
- [Task lifecycle and the 8-state machine](#task-lifecycle-and-the-8-state-machine)
- [MCP tools exposed to the master](#mcp-tools-exposed-to-the-master)
- [Master skill (self-hosted)](#master-skill-self-hosted)
- [Cross-worker handoff](#cross-worker-handoff)
- [Structured results and cost](#structured-results-and-cost)
- [Attach a real master](#attach-a-real-master)
- [CLI](#cli)
- [Remote Worker Daemon (cross-machine workers)](#remote-worker-daemon-cross-machine-workers)
- [Safety and limits](#safety-and-limits)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)
- [Verification](#verification)
- [Roadmap](#roadmap)
- [License](#license)

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

What it is **not** — so nobody adopts it for the wrong job:

- **Not an agent IDE or GUI.** No desktop app, no chat pane, no visual canvas. The
  master is the agent you already use.
- **Not an agent framework.** It defines no agent loop, prompt format, or model
  abstraction; it drives agents that already exist and speak ACP.
- **Not a workflow engine.** Tasks are flat. `dependsOn` gates them into a static
  DAG — no cycles (a dependency must already exist), no conditionals, no loops, no
  DSL. Cross-task *artifacts* still travel only through an explicit `handoff`.
- **Not a sandbox.** Isolation is git worktrees plus permission modes; it does not
  containerise or otherwise confine worker processes.

## Status

Working and verified end-to-end: an **8-state persistent task machine** (SQLite),
**async task lifecycle** (`task_submit` / `task_wait` / `task_result` / …), a
**human-in-the-loop approval flow** for worker permission/elicitation requests, a
**bounded, weighted-fair scheduler** (queue TTLs, per-task deadlines, opt-in
profile weights, `dependsOn` DAG gating, opt-in retries with backoff) for
parallel fan-out, **cross-worker handoff** (result text,
redacted diff sidecars, predecessor end-state worktrees), **enforced JSON result
contracts** with **token/cost roll-up**, a
self-hosted **master delegation skill**, and a **remote Worker Daemon** for
cross-machine workers over an authenticated, TLS-capable channel — driven against
**real local OpenCode and Pi agents** as well as deterministic mocks. See
[Verification](#verification).

## Install

agentmesh is **not published to npm yet** — install from source:

```bash
git clone https://github.com/simtfer/agentmesh.git
cd agentmesh
npm install
```

Requires Node.js ≥ 22.13. Real workers additionally require the upstream CLI
(`pi`, `opencode`, …) installed and authenticated on the machine.

The repo ships a working `agentmesh.yaml` at its root: every command reads
`./agentmesh.yaml` by default, and `--config <path>` points at a different file.
Edit the one in place, or copy it next to your project and pass `--config`.

## Try it (no API keys, no cost)

```bash
npm run demo     # Scene A: sync delegate-and-wait; Scene B: submit→waiting→approve→succeeded
npm test         # full offline suite (mocks; no network, no API cost) — see Verification for the breakdown
npm run smoke    # drives the real MCP server over stdio through the full task lifecycle
```

`demo` ends with `Scene A CLOSED ✅ | Scene B CLOSED ✅` — the master→worker→result
round trip plus the async approval loop.

To exercise the **real** agents on this machine (trivial prompt, minimal cost):

```bash
npm run real    # == npx tsx scripts/real-smoke.ts; opencode + pi through submit → wait → result
```

## Configuration

Everything under `profiles` in `agentmesh.yaml` describes **workers** the master
can spawn.

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
The optional `limits:` block (delegation depth, concurrency, queue, output and
handoff byte caps, retry attempts, dependency fan-in) is documented inline in
`agentmesh.yaml` and under [Safety and limits](#safety-and-limits).

## Task lifecycle and the 8-state machine

Every delegation is a **task** that moves through a persistent state machine:

```
queued ─▶ starting ─▶ running ─▶ succeeded
                        │  ▲
                 waiting│  │ (approve / respond)
                        ▼  │
                       (loops back to running)
   queued (no slot, TTL/deadline hit) ─▶ timed_out         (terminal)
   starting/running/waiting ─▶ queued        (retry: another attempt is due)
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
| `task_submit` | **submit a task, return a `taskId` immediately** (primary async call); `deadlineMs`/`deadlineAt` bound queue wait + execution; `dependsOn` gates it behind other tasks; `retry` re-runs transient failures; optional `handoff` chains onto a finished task; `outputSchema` enforces a JSON result contract |
| `task_status` | current status of a task |
| `task_wait` | block until terminal **or** `waiting` (needs approval) |
| `task_result` | final text / status / error of a task, plus `structured` (contract result), `usage` (tokens/cost) and `contract` (verdict) |
| `task_events` | persisted event log after a sequence number |
| `task_cancel` | request cancellation (settles once the worker confirms) |
| `list_tasks` | list tasks, optionally filtered by status |
| `scheduler_status` | running vs queued vs dependency-blocked counts, configured caps (`maxQueuedTasks`, `queueTtlMs`), the queue in dispatch order, and per-entry weight / wait / time-to-expiry |
| `usage_summary` | token/cost roll-up across tasks (`profile`, `since` filters), costs grouped by currency |
| `pending_approvals` | approval/elicitation requests blocking a `waiting` task |
| `task_approve` | resolve a permission request (allow/deny/cancel) |
| `task_respond` | answer an elicitation request |
| `dispatch_task` | synchronous convenience: submit + wait for the terminal result |
| `master_playbook` | load the self-hosted MASTER delegation skill (`lang`: `en`/`zh`) |

agentmesh also **hosts its own master skill**: the delegation playbook in
`skills/agentmesh-master/` is served over MCP as the `master_playbook` tool *and*
as two browsable resources (`agentmesh://skills/master/en`, `…/zh`). A connected
master can pull "how to delegate well" straight from the server — no copy-pasting
a prompt into each agent's config. See [Master skill](#master-skill-self-hosted).

## Master skill (self-hosted)

Giving a master the tools only tells it what it *can* do — not how to delegate
*well*. agentmesh ships a **master playbook** and serves it over MCP, so the
guidance travels with the server instead of being hand-pasted into every agent.

- **Source of truth:** `skills/agentmesh-master/SKILL.md` (English) and
  `SKILL.zh.md` (中文). Standard skill layout with YAML frontmatter, so the same
  files also work as a drop-in skill for agents that load skills from disk.
- **Served two ways:** the `master_playbook` tool (universally callable — every
  MCP client supports tools; `lang` selects `en`/`zh`) and two browsable
  resources, `agentmesh://skills/master/en` and `agentmesh://skills/master/zh`.
- **Resolved at runtime** from the agentmesh package root, so it works both from
  source (`tsx src/cli.ts mcp`) and from the built/installed binary
  (`node dist/cli.js mcp`); `skills/` is included in the published package.

The playbook covers the five rules (async-first, worker output is untrusted data,
look before you delegate, backpressure is a signal, stop for humans on the
irreversible), the delegation loop, an intent→tool cheat-sheet, how to write a
self-contained subtask prompt, anti-patterns, and the security red lines that
mirror agentmesh's own guarantees. A master should call `master_playbook` once
before its first fan-out.

## Cross-worker handoff

A fan-out isn't always independent — sometimes task B should *continue from* task
A (A writes a report, B reviews it; A patches, B tests). The `handoff` field on
`task_submit` / `dispatch_task` chains one task onto a finished predecessor
without the master copying A's output by hand.

```jsonc
{
  "task": "Review the patch and flag anything unsafe.",
  "profile": "pi",
  "handoff": { "fromTaskId": "<taskA>", "inject": "diff", "base": "predecessor" }
}
```

Two independent axes:

| field | value | meaning |
|---|---|---|
| `inject` | `"result"` (default) | the predecessor's final text, inlined into the prompt |
| | `"diff"` | the predecessor's working-tree patch, as a redacted sidecar file |
| `base` | `"repo"` (default) | the successor's worktree branches from the repo's HEAD |
| | `"predecessor"` | …from a snapshot of the predecessor's end state |

- **`inject: "result"`** prepends the persisted result text, wrapped in an
  untrusted envelope (`<<<UPSTREAM WORKER OUTPUT  trusted=NO … >>>`) that tells
  the worker to treat the block strictly as **data to act on, never as
  instructions**. Another worker's output is not a command channel.
- **`inject: "diff"`** keeps the patch out of the prompt. It captures the
  predecessor's working-tree diff — tracked edits *and* new untracked files,
  honouring `.gitignore` — redacts secret-shaped strings (`AKIA…`, `ghp_…`,
  `sk-…`, `xox…`, `Bearer …`, PEM private keys, `password = …` assignments),
  caps it, and writes it to `<workdir>/handoffs/<taskId>.diff`. The prompt only
  points at that path, so a multi-megabyte patch never has to fit in a prompt.
  Redaction is pattern-based and deliberately best-effort: it reduces accidental
  leakage, it is **not** a guarantee, and the artifact remains untrusted data.
- **`base: "predecessor"`** snapshots the predecessor's working tree into a commit
  (`git write-tree` + `commit-tree` against a temporary index) and creates the
  successor's worktree from it — so the successor literally starts where the
  predecessor stopped, with its uncommitted work in place. The predecessor's own
  branch, index and files are never modified. Requires the successor to run in a
  worktree (`handoff_base_requires_worktree` otherwise).
- **Ephemeral by design.** The augmented prompt is built at run time; the *stored*
  `prompt` stays exactly what the master submitted. Only a compact
  `metadata.handoff` summary (`fromTaskId`, `inject`, `base`, `injectedBytes`,
  `truncated`, `filesChanged`, `addedLines`, `deletedLines`, `redactions`,
  `artifact`) and a `handoff` event are persisted.
- **Admission validation.** Unknown source → `handoff_unknown_task`; source not
  `succeeded` → `handoff_predecessor_not_ready`; a remote successor for an
  artifact handoff → `handoff_artifact_unavailable`; a dead or foreign checkout
  for `base: "predecessor"` → `handoff_base_unavailable`. All are refused
  *without spawning a worker*.
- **Byte cap.** `handoff.maxBytes` (falling back to `limits.maxHandoffBytes`,
  default 256 KiB), truncated on a UTF-8 boundary and flagged `truncated`.

> Diff handoffs and predecessor snapshots assume the successor runs on the same
> host as the master. A `driver: remote` successor can see neither artifact, so
> agentmesh refuses the combination rather than handing it a path it cannot read.

## Structured results and cost

Free-form prose is fine for a human reader and useless for a program. Two opt-in
features make a fan-out machine-consumable: an enforced **JSON result contract**
and a **token/cost roll-up**.

### Result contracts

```jsonc
{
  "task": "Extract the failing test names as JSON.",
  "profile": "pi",
  "outputSchema": {
    "type": "object",
    "required": ["tests"],
    "properties": { "tests": { "type": "array", "items": { "type": "string" } } },
    "additionalProperties": false
  }
}
```

The schema is appended to the worker's prompt as a `OUTPUT CONTRACT (enforced)`
block — last, so it reads as the final formatting rule — asking for one raw JSON
value and nothing else. When the turn finishes, agentmesh parses the reply and
validates it:

- **Parsing is tolerant, validation is not.** Agents fence or pad their JSON even
  when told not to, so the parser tries the whole reply, then a ```` ```json ````
  block, then the first balanced `{…}` / `[…]` region. Nothing parseable →
  `output_not_json`.
- **A violation fails the task.** `output_schema_invalid` carries up to ten
  validator errors with their JSON paths in `error.message` and
  `metadata.outputContract.errors`. The offending text is still stored, because a
  failure you cannot see is worse than one you can.
- **`structured` is the payoff.** On success `task_result` returns the parsed value
  in `structured` (and `task_status` carries it on the record), so a master can
  read a list, a table or a boolean verdict without re-parsing prose.
- **The schema is prompt, not data.** It must serialize to ≤ 16 KiB
  (`output_schema_too_large` otherwise) and it is never persisted on the task —
  only the parsed value and a compact `metadata.outputContract` verdict.
- Keywords are evaluated with **draft-07 semantics** (ajv); a `$schema` naming
  another draft is ignored rather than treated as a hard error.

### Cost and usage roll-up

Workers that report usage (ACP `usage_update`, e.g. Claude Code) feed a per-task
record in `usage`:

```jsonc
{
  "inputTokens": 1200, "outputTokens": 340, "cachedReadTokens": 800,
  "cost": { "amount": 0.0123, "currency": "USD" },
  "contextUsed": 12000, "contextSize": 200000, "reports": 4
}
```

Two decisions matter here:

- **Latest report wins, not the sum.** ACP reports the *current state* of the
  session — token counts are per-turn totals and cost is cumulative — so folding
  every report in by addition would multiply-count. Each new report replaces the
  previous one.
- **Cost is a delta.** Reusing a worker via `workerId` means its cumulative cost
  already includes earlier tasks; agentmesh remembers the baseline at turn start
  and attributes only the difference to this task. (A counter that goes backwards
  — an adapter restart — is treated as a per-turn figure instead.)

`usage_summary` aggregates across tasks, filtered by `profile` and `since`.
Costs are grouped by currency and never summed across currencies. Absent fields
mean "the agent never reported it", not zero — adapters differ in what they emit.

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

# run workers on another machine (see "Remote Worker Daemon")
npx tsx src/cli.ts daemon   --config agentmesh.yaml --host 127.0.0.1 --port 8790 \
  --token-env AGENTMESH_DAEMON_TOKEN
```

> Note: `submit` from the one-shot CLI persists the task but its live run ends
> with the process. For real async use, submit through the long-lived `mcp`
> server (or a resident orchestrator) so the run continues in the background.

## Remote Worker Daemon (cross-machine workers)

Run workers on another machine — a GPU box, a build server, a colleague's
checkout — without ever putting an ACP stdio bridge on the network. The daemon
wraps the **same** local stack (Orchestrator + TaskManager + acpx drivers) behind
an authenticated HTTP+WebSocket endpoint; on the master side a remote worker is
just another `driver: remote` profile, so dispatch, approvals, events and
persistence behave identically to a local worker.

```
master (machine A)                              worker daemon (machine B)
  driver: remote    ── WSS + Bearer token ──▶   agentmesh daemon
  RemoteWorkerDriver ◀── typed task events ──    HTTP /healthz,/profiles · WS /ws
                                                 local Orchestrator + acpx ──▶ ACP stdio (LOCAL ONLY)
```

Start it on machine B (`agentmesh daemon --token-env … --tls-cert … --tls-key …`)
and point a `driver: remote` profile at it on machine A. The short version of the
guarantees: tokens come from the environment (never config or version control),
non-loopback binds require TLS, setting `daemon.tls.ca` turns on **mutual TLS**
so a stolen token alone cannot reach an agent, `daemon.allowCwd` whitelists where
remote tasks may run, a dropped connection reconciles to `cancelled` (never a
false `succeeded`), still-running tasks can be resumed instead of re-run, and
every control-plane decision — including refused TLS handshakes — is written to a
size-rotated NDJSON audit log with secrets reduced to a non-reversible
fingerprint.

**Full guide** — daemon flags, the `driver: remote` profile, reconnect &
reconciliation (`queryRemoteTask`, `attachRemoteTask`, transparent `resume`), the
complete remote security model, key rotation, and the remote test coverage:
**[docs/remote.md](docs/remote.md)**. For two real hosts — private CA, mTLS,
firewall, boot-time start and certificate/token rotation — follow
**[docs/deploy.md](docs/deploy.md)** and verify the software side with
`npm run deploy:tls` (a real TLS run over this machine's LAN interface, not
loopback).

## Safety and limits

These guards apply to every deployment, local or remote. (Remote-specific
security — token auth, zero-downtime key rotation, cwd whitelist, TLS, and the
audit trail — lives in [docs/remote.md](docs/remote.md#security-model).)

- **Worker output is untrusted data.** Everything a worker returns — result text,
  permission requests, elicitation prompts, and any handoff artifact — is treated
  as data to act on, never as instructions to obey. Handoff injections are wrapped
  in a `trusted=NO` envelope for exactly this reason. Run untrusted work at
  `permissionMode: approve-reads`/`deny-all` and require human approval for
  irreversible operations.
- **Recursion guard.** A master is itself an agent, so a delegation chain (or a
  master↔worker loop) could recurse forever. `limits.maxDelegationDepth` (default
  8) caps it: agentmesh reads its own level from `$AGENTMESH_DELEGATION_DEPTH`
  (0 for a top-level master) and injects level+1 into every agent it spawns, so a
  nested agentmesh inherits the chain depth across process boundaries. A submit
  whose effective depth reaches the cap fails with `delegation_depth_exceeded`
  *without spawning a worker*; a caller-stamped depth can only raise it, never
  lower the inherited base.
- **Resource limits.** Two further guards bound the blast radius of a busy or
  runaway master. `limits.maxConcurrentTasks` (default unlimited) caps how many
  tasks may run at once. `limits.maxOutputBytes` (default 1 MiB) caps the result
  text persisted per task: a larger result is truncated on a UTF-8 boundary (never
  splitting a multibyte codepoint), the record is flagged `outputTruncated`, and a
  truncation note is recorded as an event so the clip is observable rather than
  silent. `limits.maxHandoffBytes` (default 256 KiB) caps how much of a
  predecessor's result a cross-worker handoff may inject into a successor prompt,
  using the same UTF-8-safe clip.
- **Bounded, fair scheduler.** What happens to a submit that arrives while every
  slot is busy is governed by `limits.maxQueuedTasks`. Left at `0` (the default),
  the submit is refused immediately with `concurrency_limit_exceeded` *without
  spawning a worker* — pure back-pressure, so a fan-out burst can't exhaust the
  host. Set it `>0` to turn on real scheduling: over-cap submits park in a bounded
  queue and drain automatically as running tasks settle, and only a submit that
  finds the queue full too is refused (`queue_full`). A single queue owner
  (`pump()`) advances the queue whenever a slot frees, so admission stays race-free
  under a same-tick burst. A queued task holds no worker and can be cancelled — it
  settles at once instead of waiting out the cancel grace period. The
  `scheduler_status` MCP tool exposes running vs queued counts, the configured
  caps, and the queue in dispatch order so a master can read back-pressure before
  fanning out.
- **Queued work has a shelf life.** `limits.queueTtlMs` caps how long a task may
  *wait*: on expiry it leaves the queue and settles `timed_out` with
  `queue_ttl_exceeded`, never having spawned a worker. A per-task deadline is
  stronger — `task_submit { deadlineMs }` (budget from submit) or `{ deadlineAt }`
  (absolute epoch ms) covers queue wait **and** execution, so a slow backlog can't
  quietly blow a wall-clock commitment: the task settles `timed_out` with
  `deadline_exceeded` whether it was still queued or already running, and a
  deadline already past at submit time is refused outright. The run timer fires at
  the *smaller* of the task's `timeoutMs` and the deadline remainder, so the two
  budgets compose instead of fighting.
- **Weighted fair queueing.** With the default profile weight of `1` the queue is
  strict FIFO (submit order == dispatch order). Give a profile a `weight` and the
  scheduler switches to weighted fair queueing with finish tags
  (`tag = max(pass[profile], virtualTime) + 1/weight`): a `weight: 3` profile gets
  roughly three dispatch slots per one of a `weight: 1` profile under contention,
  while virtual time advances on *service*, so a late arrival cannot jump a
  backlog on a stale tag. Weights only reorder *waiting* work — they never let
  more than `maxConcurrentTasks` run.
- **Dependencies (`dependsOn`).** A task may name other tasks that must settle
  `succeeded` before it is allowed to start. It is accepted immediately as
  `queued` with a `blockedBy` list, stays out of the dispatch queue (so it never
  consumes a slot or distorts queue order), and enters the queue the moment its
  last dependency succeeds. A dependency that ends any other way fails the
  dependent with `dependency_failed` — *without spawning a worker* — and that
  failure cascades down the chain, so a broken DAG collapses instead of stranding
  a tail of tasks. `blockedBy` also clears on cancellation. Gated tasks count
  against `maxQueuedTasks` (they are accepted work waiting for the scheduler), so
  `dependsOn` requires `maxQueuedTasks > 0` and refuses with
  `dependency_requires_queue` otherwise. Queue TTL starts when the task becomes
  *ready*; a per-task deadline still covers the whole wait.
- **Retries (`retry`).** Opt-in per task: `{ maxAttempts, delayMs, backoff,
  maxDelayMs, onlyRetryable }`. A failed or timed-out attempt that actually ran is
  re-queued (after the backoff) instead of settling, up to `maxAttempts` total
  runs — the record never touches a terminal state in between, so `task_wait`
  spans every attempt and dependents keep waiting. Admission refusals (queue full,
  depth exceeded, bad handoff, …) are never retried: they never reached a worker.
  Each attempt gets a fresh worker/AbortController, the failed ones are archived
  under `metadata.attempts` (status, error, timing, spend, a bounded text
  preview), and token/cost totals are **summed across attempts** because every
  attempt really spent them. `limits.maxRetryAttempts` (default 5) clamps what a
  caller may ask for.

```jsonc
// B runs only after A and C both succeeded; a dead A/C fails B immediately.
task_submit({ "prompt": "…", "profile": "pi", "dependsOn": ["<taskA>", "<taskC>"] })
// Same task, retried up to 3 times with 0.5s/1s backoff before it gives up.
task_submit({ "prompt": "…", "profile": "pi",
              "retry": { "maxAttempts": 3, "delayMs": 500, "backoff": "exponential" } })
```

Both are opt-in per task; with neither field the behaviour is unchanged (start as
soon as a slot is free, settle on the first failure).

## Troubleshooting

Every failure lands on the task record (`error.code`) *and* the event log, so
`task_result` / `task_events` tell you **why**, not just that it failed.

| `error.code` | What happened | What to do |
|---|---|---|
| `concurrency_limit_exceeded` | every slot busy and `maxQueuedTasks` is `0` | retry after one settles, or set `maxQueuedTasks > 0` to queue instead of refuse |
| `queue_full` | slots busy **and** the queue is at `maxQueuedTasks` | raise `maxQueuedTasks` or submit smaller batches; `scheduler_status` shows the backlog |
| `queue_ttl_exceeded` | waited longer than `queueTtlMs` without ever starting | raise `queueTtlMs`, add capacity, or split the batch |
| `dependency_unknown_task` | `dependsOn` names a task that does not exist (a task under another `workdir` is invisible) | fix the id |
| `dependency_failed` | a dependency settled `failed`/`cancelled`/`timed_out`, so this task can never run | fix or re-run the upstream task; the message names the culprit |
| `dependency_requires_queue` | `dependsOn` used with `maxQueuedTasks: 0` (nowhere to hold a gated task) | set `limits.maxQueuedTasks > 0` |
| `dependency_limit_exceeded` | more entries in `dependsOn` than `limits.maxDependencies` (default 16) | split the fan-in or raise the cap |
| `deadline_exceeded` | hit its `deadlineMs`/`deadlineAt` — while queued **or** running | give it a bigger budget; if it never started, that's a capacity problem, not a task problem |
| `task_timeout` | the run exceeded `timeoutMs` (no deadline involved) | raise `timeoutMs` for long turns |
| `delegation_depth_exceeded` | the chain reached `maxDelegationDepth` | usually a master delegating in a loop — inspect the chain before raising the cap |
| `handoff_unknown_task` | `handoff.fromTaskId` matches no stored task | check the id; a task under another `workdir` is invisible |
| `handoff_predecessor_not_ready` | the predecessor is not `succeeded` yet | `task_wait` on it first; failed/cancelled output is never handed off |
| `handoff_base_requires_worktree` | `base: "predecessor"` without a worktree | pass `worktree: true` or enable it on the profile |
| `handoff_base_unavailable` | the predecessor's checkout is gone or in another repo | keep its worker alive until the successor starts |
| `handoff_artifact_unavailable` | a `diff`/`predecessor` handoff targets a remote worker, or the checkout vanished | run the successor locally, or use `inject: "result"` |
| `output_not_json` | `outputSchema` was set but the reply contains no parseable JSON | restate the contract in the task ("reply with JSON only"); `retryable`, so re-running is reasonable |
| `output_schema_invalid` | the reply parsed but violates the schema | read `metadata.outputContract.errors` for the offending paths — usually one field the prompt never pinned down |
| `output_schema_too_large` | the schema exceeds 16 KiB | trim descriptions/examples; the schema goes into the prompt |

Symptoms that aren't error codes:

- **A task sits in `waiting` and nothing happens.** It is blocked on a permission
  or elicitation request — call `pending_approvals`, then `task_approve` /
  `task_respond`. `task_wait` returns as soon as this occurs, by design.
- **`dispatch_task` appears to hang.** It waits for a terminal state, so a task
  that needs approval can never advance inside it. Use `task_submit` +
  `task_wait` when human intervention is possible.
- **`cli submit` exits and the task never progresses.** Expected: the one-shot
  CLI's live run ends with the process. Use the long-lived `mcp` server for real
  async work (also called out under [CLI](#cli)).
- **Daemon refuses the connection or returns 401.** Bind/TLS/token rules are in
  [docs/remote.md](docs/remote.md#security-model); the token must come from the
  environment named by `--token-env`.
- **A remote task fails with a TLS error** (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`,
  `CERT_HAS_EXPIRED`, `altname`, `alert certificate required`, `ECONNRESET`
  immediately after connecting). These are certificate problems, not agent
  problems — the table in [docs/deploy.md](docs/deploy.md#7-troubleshooting) maps
  each one to its cause and fix.

## Architecture

```
src/
  index.ts             public package entry (the surface `package.json#exports` points at)
  types.ts             domain types (WorkerProfile, TaskRecord, TaskStatus, TaskEvent, ...)
  config.ts            YAML load + zod validation
  statemachine.ts      8-state transitions + terminal/legality guards
  worktree.ts          git-worktree isolation for parallel workers
  handoff.ts           diff capture, secret redaction, end-state snapshots, sidecars
  contract.ts          JSON result contracts: extraction, ajv validation, prompt block
  registry.ts          worker lifecycle + bounded event log
  approvals.ts         ApprovalBroker: bridges permission/elicitation to the master
  tasks.ts             TaskManager: async 8-state lifecycle, timeout/cancel, approvals, handoff
  store/
    memory.ts          in-memory TaskStore (tests, persist:false)
    sqlite.ts          durable TaskStore on node:sqlite (default)
  orchestrator.ts      the core facade: workers + tasks + store + drivers
  drivers/
    factory.ts         picks a driver per profile (acpx/remote lazily constructed)
    acpxDriver.ts      real ACP workers via acpx runtime (+ permission/elicitation hooks)
    mockDriver.ts      deterministic offline worker (demo/tests, incl. requireApproval)
  remote/
    protocol.ts        versioned wire messages (submit/approve/respond/cancel + events)
    security.ts        token compare, cwd whitelist, TLS load, safe-bind guard
    daemon.ts          WorkerDaemon: HTTP+WS shim wrapping a local Orchestrator
    client.ts          RemoteWorkerDriver: a remote profile as a normal WorkerDriver
    audit.ts           append-only NDJSON audit log; secrets reduced to a fingerprint
  mcp/server.ts        exposes the orchestrator as 18 MCP tools over stdio
  skill.ts             loads the self-hosted master playbook from skills/ (root resolver)
  cli.ts               demo | list | mcp | dispatch | submit | tasks | daemon
skills/
  agentmesh-master/    the master delegation playbook (SKILL.md + SKILL.zh.md),
                       served over MCP as the master_playbook tool + resources
scripts/
  mcp-smoke.mjs        drives the real MCP server over stdio (`npm run smoke`)
  real-smoke.ts        drives real opencode + pi workers (`npm run real`)
  remote-tls-deploy.ts real TLS/mTLS run over a LAN interface (`npm run deploy:tls`)
deploy/
  certs/make-certs.sh  generates a CA + server/client certificates for one host
  systemd/             boot-time unit (systemd)
  windows/             boot-time launcher (Task Scheduler)
docs/
  remote.md            the full Remote Worker Daemon guide
  deploy.md            two-host runbook: CA, mTLS, firewall, boot, rotation
  verification.md      the full test-by-test verification log
  PLAN.md              design notes + roadmap
```

**Role symmetry:** nothing in the code says "opencode is master". The master is
whoever has the MCP server attached; workers are whoever the adapter drives.
Swap the two and it still works.

## Verification

```bash
npm run typecheck   # tsc --noEmit, clean
npm test            # 108 tests, offline, no API cost, ~25s
npm run demo        # Scene A + Scene B both close
npm run smoke       # real MCP server over stdio through the full lifecycle
npm run deploy:tls  # real TLS/mTLS run over this host's LAN interface (not loopback)
npm run real        # real local opencode + pi (both must be installed & authenticated)
```

`npm test` is **108/108** across eight files — lifecycle, persistence and guards (32),
handoff artifacts (12), result contracts and usage (10), dependencies and retries
(18), remote daemon (18), deployment TLS and audit rotation (8), orchestrator (6),
master skill (4).
Every case drives a public surface (Orchestrator, MCP tools, or the daemon's
HTTP/WS endpoints) and asserts the resulting task record, not a mock's internal
calls.

Last run on Windows with Node v22.22. Real OpenCode and Pi workers have also been
driven end-to-end (`npm run real`: both reach `succeeded` and persist 2 tasks /
27 events).

**Per-case breakdown, reproduce steps, and the known gaps — what is *not* covered
yet: [docs/verification.md](docs/verification.md).**

## Roadmap

Done:

- ✅ Async task lifecycle with an 8-state machine + SQLite persistence.
- ✅ Human-in-the-loop approvals (permission + elicitation) via the broker.
- ✅ Real ACP workers (OpenCode, Pi) verified end-to-end.
- ✅ Remote Worker Daemon: run workers on other machines over an authenticated,
  TLS-capable channel (ACP stdio never crosses the network).
- ✅ Recursion guard + resource limits (delegation depth, concurrency, output size).
- ✅ Bounded FIFO scheduler: parallel fan-out with a single queue owner,
  over-cap queueing, and `scheduler_status` introspection.
- ✅ Queue TTL + per-task deadlines (`deadlineMs` / `deadlineAt`, covering queue
  wait + execution) and weighted cross-profile fairness (opt-in via `weight`).
- ✅ Self-hosted master skill: the delegation playbook ships in the repo and is
  served over MCP (`master_playbook` tool + resources), so a master delegates
  well by default without any copy-paste.
- ✅ Cross-worker handoff, all three phases: chain a task onto a finished
  predecessor's `result`; hand off its working-tree `diff` as a redacted sidecar
  file instead of inlining the patch; and start the successor's worktree from a
  snapshot of the predecessor's end state. Injected artifacts are untrusted data
  under a byte cap, and the stored prompt stays original.
- ✅ Structured result contracts (`outputSchema`, enforced — a violation fails the
  task) and token/cost roll-up from ACP `usage_update` events, per task and
  aggregated through `usage_summary`.
- ✅ DAG dependencies (`dependsOn`: ready-queue admission, failure/cancel cascade,
  queue-capacity accounting) and opt-in retries with fixed/exponential backoff,
  attempt archiving, and spend summed across attempts.
- ✅ Deployment hardening: optional mutual TLS, certificate/key/CA paths resolved
  and validated (`tls_invalid` instead of an opaque handshake failure),
  size-rotated audit log, boot-time unit/task, firewall recipes, and a
  two-host runbook verified over a real interface (`npm run deploy:tls`).

Next:

- **Approval budgets** — cap how many `waiting` tasks a fan-out may open before it
  must stop and ask, and let a task carry a cost ceiling that `usage_summary`
  enforces.
- **Optional web console** — the audit trail and scheduler status already expose
  the data a read-only view would render.

Design notes, rejected alternatives and the staged build-up behind these
decisions: [docs/PLAN.md](docs/PLAN.md).

## License

MIT
