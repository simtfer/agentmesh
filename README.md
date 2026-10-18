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

## Contents

- [Why this shape](#why-this-shape)
- [Status](#status)
- [Install](#install)
- [Try it (no API keys, no cost)](#try-it-no-api-keys-no-cost)
- [Configuration](#configuration)
- [Task lifecycle and the 8-state machine](#task-lifecycle-and-the-8-state-machine)
- [MCP tools exposed to the master](#mcp-tools-exposed-to-the-master)
- [Master skill (self-hosted)](#master-skill-self-hosted)
- [Cross-worker handoff (Phase 1)](#cross-worker-handoff-phase-1)
- [Attach a real master](#attach-a-real-master)
- [CLI](#cli)
- [Remote Worker Daemon (cross-machine workers)](#remote-worker-daemon-cross-machine-workers)
- [Safety and limits](#safety-and-limits)
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

## Status

Working and verified end-to-end: an **8-state persistent task machine** (SQLite),
**async task lifecycle** (`task_submit` / `task_wait` / `task_result` / …), a
**human-in-the-loop approval flow** for worker permission/elicitation requests, a
**bounded, weighted-fair scheduler** (queue TTLs, per-task deadlines, opt-in
profile weights) for parallel fan-out, **cross-worker handoff**, a
self-hosted **master delegation skill**, and a **remote Worker Daemon** for
cross-machine workers over an authenticated, TLS-capable channel — driven against
**real local OpenCode and Pi agents** as well as deterministic mocks. See
[Verification](#verification).

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
npm test         # full offline suite (mocks; no network, no API cost) — see Verification for the breakdown
npm run smoke    # drives the real MCP server over stdio through the full task lifecycle
```

`demo` ends with `Scene A CLOSED ✅ | Scene B CLOSED ✅` — the master→worker→result
round trip plus the async approval loop.

To exercise the **real** agents on this machine (trivial prompt, minimal cost):

```bash
npx tsx scripts/real-smoke.ts   # opencode + pi through submit → wait → result
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
handoff byte caps) is documented inline in `agentmesh.yaml` and under
[Safety and limits](#safety-and-limits).

## Task lifecycle and the 8-state machine

Every delegation is a **task** that moves through a persistent state machine:

```
queued ─▶ starting ─▶ running ─▶ succeeded
                        │  ▲
                 waiting│  │ (approve / respond)
                        ▼  │
                       (loops back to running)
   queued (no slot, TTL/deadline hit) ─▶ timed_out         (terminal)
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
| `task_submit` | **submit a task, return a `taskId` immediately** (primary async call); `deadlineMs`/`deadlineAt` bound queue wait + execution; optional `handoff` chains onto a finished task |
| `task_status` | current status of a task |
| `task_wait` | block until terminal **or** `waiting` (needs approval) |
| `task_result` | final text / status / error of a task |
| `task_events` | persisted event log after a sequence number |
| `task_cancel` | request cancellation (settles once the worker confirms) |
| `list_tasks` | list tasks, optionally filtered by status |
| `scheduler_status` | running vs queued counts, configured caps (`maxQueuedTasks`, `queueTtlMs`), the queue in dispatch order, and per-entry weight / wait / time-to-expiry |
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

## Cross-worker handoff (Phase 1)

A fan-out isn't always independent — sometimes task B should *continue from*
task A's result (A writes a report, B reviews it; A patches, B tests). The
`handoff` field on `task_submit` / `dispatch_task` chains one task onto a
finished predecessor without the master having to copy A's output by hand.

```jsonc
{
  "task": "Review the report and flag any unsupported claims.",
  "profile": "pi",
  "handoff": { "fromTaskId": "<taskA>", "inject": "result" }
}
```

- **What gets injected.** At run time agentmesh reads the predecessor's persisted
  `result` text and prepends it to *this* task's prompt, wrapped in an untrusted
  envelope (`<<<UPSTREAM WORKER OUTPUT  trusted=NO … >>>`) that tells the worker
  to treat the block strictly as **data to act on, never as instructions**. This
  mirrors agentmesh's core rule: another worker's output is not a command channel.
- **Ephemeral by design.** The augmented prompt is built at run time and handed to
  the worker; the *stored* `prompt` stays exactly what the master submitted. Only
  a compact `metadata.handoff` summary (`fromTaskId`, `inject`, `base`,
  `injectedBytes`, `truncated`) and a `handoff` event are persisted — so large or
  sensitive artifacts never land in the prompt column.
- **Admission validation.** A handoff whose source task is unknown is refused
  (`handoff_unknown_task`); one whose source hasn't reached `succeeded` yet is
  refused (`handoff_predecessor_not_ready`) — both *without spawning a worker*, so
  you can't chain onto a task that's still running or failed.
- **Byte cap.** The injected artifact is capped to `handoff.maxBytes` (falling back
  to `limits.maxHandoffBytes`, default 256 KiB), truncated on a UTF-8 boundary and
  flagged `truncated` in the metadata — the same safe-clip used for oversized
  results.

Phase 1 covers `inject: "result"` over a `base: "repo"` worktree. Later phases add
`inject: "diff"` (capture the predecessor's working-tree diff as a redacted artifact
sidecar) and `base: "predecessor"` (start the successor in a worktree branched from
the predecessor's end state).

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
non-loopback binds require TLS, `daemon.allowCwd` whitelists where remote tasks
may run, a dropped connection reconciles to `cancelled` (never a false
`succeeded`), still-running tasks can be resumed instead of re-run, and every
control-plane decision is written to an NDJSON audit log with secrets reduced to
a non-reversible fingerprint.

**Full guide** — daemon flags, the `driver: remote` profile, reconnect &
reconciliation (`queryRemoteTask`, `attachRemoteTask`, transparent `resume`), the
complete remote security model, key rotation, and the remote test coverage:
**[docs/remote.md](docs/remote.md)**.

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

## Architecture

```
src/
  types.ts             domain types (WorkerProfile, TaskRecord, TaskStatus, TaskEvent, ...)
  config.ts            YAML load + zod validation
  statemachine.ts      8-state transitions + terminal/legality guards
  worktree.ts          git-worktree isolation for parallel workers
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
  mcp/server.ts        exposes the orchestrator as 17 MCP tools over stdio
  skill.ts             loads the self-hosted master playbook from skills/ (root resolver)
  cli.ts               demo | list | mcp | dispatch | submit | tasks | daemon
skills/
  agentmesh-master/    the master delegation playbook (SKILL.md + SKILL.zh.md),
                       served over MCP as the master_playbook tool + resources
docs/
  remote.md            the full Remote Worker Daemon guide
  PLAN.md              design notes + roadmap
```

**Role symmetry:** nothing in the code says "opencode is master". The master is
whoever has the MCP server attached; workers are whoever the adapter drives.
Swap the two and it still works.

## Verification

Checked on this machine (Node v26, Windows):

- `tsc --noEmit` — clean.
- `npm test` — **60/60** pass:
  - `test/orchestrator.test.ts` — spawn/dispatch, event streaming, worktree.
  - `test/tasks.test.ts` (32) — happy path, worker failure, `timeout → timed_out`,
    `cancel → cancelled`, `waiting → approve → succeeded`, `reject → failed`,
    idempotency de-dup, SQLite restart-and-requery, store column-merge safety, an
    old-schema DB forward-migrated with the `deadlineAt` column, the
    recursion guard (depth-stamped success within the cap, refusal at the cap with
    no worker spawned, and an inherited env depth tripping the cap), the
    resource limits (a submit past `maxConcurrentTasks` refused with no worker,
    a settled task freeing its slot, an oversized result truncated + flagged
    `outputTruncated`, and truncation never splitting a multibyte codepoint), the
    Stage 5 scheduler (over-cap submits queue then drain FIFO as slots free, a
    full queue refuses with `queue_full`, cancelling a queued task settles
    immediately without the grace wait, and a fan-out runs concurrently bounded by
    `maxConcurrentTasks`), queue TTL and deadlines (a queued task expires
    `queue_ttl_exceeded` without ever spawning a worker, a queued task's
    `deadlineMs` expires `deadline_exceeded`, a running turn is bounded by its
    deadline rather than its much larger `timeoutMs`, and an already-past deadline
    is refused at submit), weighted fairness (default weights keep submit order
    exactly; a `weight: 3` profile takes 3 of the first 4 dispatch slots), and
    Phase 1 cross-worker handoff (the predecessor's
    result reaches the successor's prompt, a no-handoff control never sees it, the
    injected block is wrapped untrusted while the stored prompt stays original, a
    non-succeeded / unknown source is refused with no worker spawned, and the
    artifact is capped to `maxBytes` and flagged `truncated`).
  - `test/remote.test.ts` (18) — loopback daemon ↔ `RemoteWorkerDriver`: dispatch +
    streamed events, approval round-trip, cancel, bad-token rejection,
    cwd-whitelist refusal, `/healthz` vs `/profiles` auth split, reconnect
    reconciliation (completed-task query, unknown-id → `undefined`, dropped
    mid-run → `cancelled` not `succeeded`), push-based resumption (`attach`
    replays to success, `afterSequence` boundary, unknown-task reject, transparent
    `runTurn` re-attach), zero-downtime key rotation (multi-token accept over
    HTTP + WS, live `reloadTokens()`, empty-set refusal), a structured NDJSON
    audit trail (decisions recorded, token never in cleartext), and unit guards
    for `assertSafeBind` / `assertCwdAllowed`. See
    [docs/remote.md](docs/remote.md#remote-tests).
  - `test/skill.test.ts` (4) — the self-hosted master skill: the package-root
    resolver finds `skills/agentmesh-master/`, both languages load from disk, and
    an in-memory MCP client confirms the server serves the playbook via the
    `master_playbook` tool (`en`/`zh`) and as browsable resources.
- `npm run demo` — Scene A (sync dispatch to two workers) and Scene B
  (submit → waiting → approve → succeeded) both close.
- `npm run smoke` — real MCP stdio server through the full lifecycle; event
  sequence `accepted, started, output…, waiting, resumed, output…, completed`.
- `agentmesh daemon` boot check — `/healthz` open, `/profiles` 401 without a token
  and 200 with `Authorization: Bearer …`, clean SIGINT shutdown.
- `scripts/real-smoke.ts` — **real local OpenCode and Pi** driven through
  `task_submit → task_wait → task_result`; both return `OK`, reach `succeeded`,
  and persist their tasks + events to SQLite (2 tasks / 27 events observed).

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
- ✅ Cross-worker handoff (Phase 1): chain a task onto a finished predecessor's
  `result`, injected as untrusted data under a byte cap, with the stored prompt
  left original.

Next:

- Cross-worker handoff Phase 2/3 (`inject: "diff"` artifact sidecar + redaction,
  `base: "predecessor"` worktree branched from the predecessor's end state).
- Structured result contracts (JSON output schema per task) + cost/usage roll-up
  from ACP `usage_update` events.

## License

MIT
