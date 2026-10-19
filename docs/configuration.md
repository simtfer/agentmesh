# Configuration

Every command reads `./agentmesh.yaml` by default; `--config <path>` points at a
different file. The repo ships a working one at its root, with the same keys
documented inline — this file is the reference version.

Roles are **not** tied to agent type. The master is whichever agent the MCP server
is attached to; everything under `profiles` describes **workers** the master can
spawn.

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

## Contents

- [Top-level keys](#top-level-keys)
- [Profiles](#profiles)
- [Limits](#limits)
- [Daemon block](#daemon-block)

## Top-level keys

| key | default | meaning |
|---|---|---|
| `workdir` | `.agentmesh` | where git worktrees, the SQLite store and acpx session state live; relative to the run directory |
| `defaults.permissionMode` | `approve-all` | `deny-all` / `approve-reads` / `approve-all` — the ACP permission mode workers inherit |
| `defaults.cwd` | process cwd | default working directory for workers |
| `limits` | see below | caps on depth, concurrency, queueing, output, retries, spend |
| `profiles` | — | the workers the master may spawn |

`agentmesh.yaml` is validated with zod at load time: an unknown `driver`, a
missing `remote.endpoint`, or a `daemon` block without a resolvable token env var
fails before any worker starts.

## Profiles

| field | applies to | meaning |
|---|---|---|
| `name` | all | the id used in `task_submit { profile }` |
| `driver` | all | `mock`, `acpx`, or `remote` |
| `description` | all | human label surfaced by `agent_list` |
| `worktree` | all | run in an isolated git worktree (required for `handoff.base: "predecessor"`) |
| `weight` | all | queue weight; `1` (default) is strict FIFO, any other value turns on weighted fair queueing |
| `agent` | `acpx` | an acpx built-in name: `pi`, `opencode`, `codex`, `claude`, `gemini`, `cursor`, `qwen`, `qoder`, … |
| `command` | `acpx` | explicit argv, for an agent acpx does not know by name (pairs with a custom `agent` key) |
| `model` | `acpx` | model id passed through to the agent |
| `permissionMode` | `acpx` | per-profile override of `defaults.permissionMode` |
| `mock` | `mock` | `{ delayMs, toolCalls, requireApproval, failFirst }` — deterministic offline behaviour |
| `remote` | `remote` | `{ endpoint, tokenEnv, remoteProfile, resume, reconnectAttempts, reconnectDelayMs, ca, cert, key, connectTimeoutMs }` — see [`remote.md`](./remote.md) |

Notes that save debugging time:

- `agent` must be paired with a matching acpx entry; anything else needs an
  explicit `command`. A typo produces a launch failure at spawn time, not at load
  time.
- `remote.tokenEnv` names an environment variable — the token **value** is never
  written to the config file, and the daemon refuses a remote submit whose token
  env var is unset.
- `worktree: true` is what makes parallel edits safe; without it two workers edit
  the same checkout.

## Limits

All keys are optional, and `0`/omitted means "no cap" unless noted.

| key | default | meaning |
|---|---|---|
| `maxDelegationDepth` | `8` | nested delegation depth, carried across processes via `$AGENTMESH_DELEGATION_DEPTH` |
| `maxConcurrentTasks` | unlimited | tasks allowed to run at once |
| `maxQueuedTasks` | `0` | `0` = refuse over-cap submits; `>0` = bounded queue (required for `dependsOn`) |
| `queueTtlMs` | `0` | how long a queued task may wait; `0` = forever |
| `maxOutputBytes` | `1 MiB` | persisted result text per task, truncated on a UTF-8 boundary |
| `maxHandoffBytes` | `256 KiB` | predecessor result injected into a successor prompt |
| `maxRetryAttempts` | `5` | clamps every task's `retry.maxAttempts` |
| `maxDependencies` | `16` | max `dependsOn` entries per task |
| `maxWaitingTasks` | unlimited | tasks allowed to block on approvals at once |
| `maxTotalTokens` | `0` | process-wide token ceiling; past it, new submits are refused |
| `maxTotalCost` | — | `{ amount, currency }`, process-wide cost ceiling |

What each cap does when it fires — and which error code you get — is in
[`limits.md`](./limits.md).

## Daemon block

Only meaningful on the machine running `agentmesh daemon`. Defaults can be
overridden per launch with `--host` / `--port` / `--token-env` / `--tls-cert` /
`--tls-key` / `--tls-ca`.

```yaml
daemon:
  host: 127.0.0.1              # non-loopback bind REQUIRES tls (or --allow-insecure)
  port: 8790
  tokenEnv: AGENTMESH_DAEMON_TOKEN   # daemon refuses to start if unset
  allowCwd:                    # a remote task's cwd must sit inside one of these
    - /srv/agentmesh/repos
  tls:
    cert: ./certs/daemon.pem
    key:  ./certs/daemon-key.pem
    # ca: ./certs/client-ca.pem      # enables mTLS client verification
  exposeProfiles: [opencode, pi]      # default: every non-remote profile
  orphanGraceMs: 30000                # keep a dropped task alive so a client can re-attach
  workerIdleMs: 1800000               # reap a reused worker after 30 min idle (0 = never)
  auditPath: /var/log/agentmesh/daemon-audit.ndjson
  auditMaxBytes: 10485760             # rotate at 10 MiB (0 = never)
  auditKeep: 5                        # keep 5 archives: .1 = newest
```

Token rotation with no downtime: list several env var names
(`VAR_OLD,VAR_NEW`) or several comma-separated values in one variable, then send
`SIGHUP`. Full daemon behaviour: [`remote.md`](./remote.md).
