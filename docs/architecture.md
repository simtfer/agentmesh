# Architecture

Where each responsibility lives, and the one design rule that explains the shape:
**the master is whoever holds the MCP connection, the worker is whoever the
adapter drives.** Nothing in the code hard-codes an agent type to a role.

## Contents

- [Three layers](#three-layers)
- [Source map](#source-map)
- [Role symmetry](#role-symmetry)
- [Two protocols, no reinvention](#two-protocols-no-reinvention)

## Three layers

```
inbound                core                                    outbound
MCP tools (stdio)  ─▶  Orchestrator ─▶ TaskManager ─▶ Worker ─▶ driver
(any MCP client)       (facade)        (8-state)       registry   ├─ acpx  ─▶ ACP stdio (local process)
                                                                  └─ remote ─▶ WS to another host
                              │
                              └─▶ TaskStore (SQLite / memory) + event log
```

- **Inbound** is a thin MCP layer: it validates arguments, calls the orchestrator,
  and formats results. No lifecycle logic lives there.
- **Core** is the orchestrator facade plus the task manager, state machine,
  registry, approvals broker, handoff builder and contract checker. Everything
  that can refuse a task refuses it here — before a worker is spawned.
- **Outbound** is a driver per profile. `acpx` runs a real ACP agent locally;
  `remote` forwards the same intent over an authenticated WebSocket to a daemon
  that runs the very same core on another machine.

Persistence is orthogonal: a task record and its event log go to SQLite
(`node:sqlite`) by default, or to an in-memory store for tests.

## Source map

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
    protocol.ts        versioned wire messages (submit/approve/respond/cancel + events + artifacts)
    security.ts        token compare, cwd whitelist, artifact staging, TLS load, safe-bind guard
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
  configuration.md     every key in agentmesh.yaml
  cli.md               commands + attaching a master
  lifecycle.md         8-state machine, delegation modes, approvals
  mcp-tools.md         the 18 tools + the self-hosted playbook
  handoff.md           cross-worker handoff shapes
  contracts.md         JSON result contracts + usage/cost roll-up
  limits.md            safety guards, scheduler, retries, budgets
  troubleshooting.md   error-code table + symptoms
  remote.md            the full Remote Worker Daemon guide
  deploy.md            two-host runbook: CA, mTLS, firewall, boot, rotation
  verification.md      the full test-by-test verification log
  PLAN.md              design notes + roadmap
```

## Role symmetry

Nothing in the code says "opencode is master". The master is whoever has the MCP
server attached; workers are whoever the adapter drives. Swap the two and it still
works — which is also why the daemon reuses the entire core instead of defining a
second task model.

## Two protocols, no reinvention

- **ACP (Agent Client Protocol)** — Zed's open JSON-RPC-over-stdio protocol for
  driving coding agents. OpenCode (`opencode acp`), Pi (`npx pi-acp`), Gemini,
  Codex, Claude Code, Cursor, Qwen and more all speak it. The adapter reuses
  [`acpx`](https://github.com/openclaw/acpx) as the ACP client, so **one
  integration drives every worker**.
- **MCP (Model Context Protocol)** — how the master gains orchestration
  superpowers. The adapter exposes tools; any MCP-capable agent that connects
  becomes a master **with zero changes to itself**.

This is deliberately lighter than agent-orchestrator IDEs (Electron/GUI) and
tmux-screen-scraping supervisors: the master stays a normal agent, workers stay
normal agents, and the adapter is just the protocol bridge + lifecycle manager
between them.
