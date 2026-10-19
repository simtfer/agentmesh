# Quickstart: two machines, one task

Master on machine **A**, worker daemon on machine **B**, first delegated task
running end to end. Fifteen minutes if Node is already installed.

The scenario throughout: **A runs Claude Code**, which drives the mesh over MCP,
and **B runs pi**, which does the actual code editing. Every other combination
works the same way — roles come from configuration — but a concrete pair is
easier to follow than `agent A` / `agent B`.

```
A — master                                     B — worker
┌──────────────────────────────┐  WSS :8790    ┌──────────────────────────────┐
│ Claude Code                  │ ────────────▶ │ agentmesh daemon (TLS)       │
│   └── node dist/cli.js mcp   │ ◀──────────── │ local agent: pi (via acpx)   │
└──────────────────────────────┘  task events  └──────────────────────────────┘
```

Only the worker needs an inbound port, and only the worker runs a coding agent.
The master never accepts connections; it dials out and streams events back.

## Contents

- [0. On both machines](#0-on-both-machines)
- [1. Machine B: certificates and config](#1-machine-b-certificates-and-config)
- [2. Machine B: start the daemon](#2-machine-b-start-the-daemon)
- [3. Machine A: point at B and run a task](#3-machine-a-point-at-b-and-run-a-task)
- [4. Swap the mock for the real pi agent](#4-swap-the-mock-for-the-real-pi-agent)
- [5. Machine A: attach Claude Code](#5-machine-a-attach-claude-code)
- [6. If it does not work](#6-if-it-does-not-work)
- [Next](#next)

## 0. On both machines

```bash
git clone https://github.com/simtfer/agentmesh.git
cd agentmesh && npm ci && npm run build      # produces dist/cli.js
```

Requirements: **Node ≥ 22.13**; on B also `openssl` (Git Bash ships it on
Windows). Every command below is `node dist/cli.js …`; `npm link` gives you a
plain `agentmesh` if you prefer.

Two more things, installed further down so this step cannot fail because of
them: **Claude Code on A** (step 5) and **pi on B** (step 4). Until then both
sides run without an agent at all.

Nothing is published to npm yet, so "install" means this clone on both hosts.
Keep both hosts on the same version: the wire protocol is versioned, and a
mismatch is refused when it matters (a v1 daemon will not silently drop a handoff
artifact, it is rejected at the handshake).

## 1. Machine B: certificates and config

A non-loopback bind without TLS is refused, so generate a private CA first. The
**SAN must contain what A dials** — an IP endpoint needs `IP:…`, a hostname
endpoint needs `DNS:…`:

```bash
bash deploy/certs/make-certs.sh --out ./certs --san "DNS:worker.internal,IP:10.0.0.12"
```

That writes `ca.pem`, `server.pem/key.pem` and a `client.pem/key.pem` pair for
mutual TLS. Keep `ca-key.pem` off the worker if you can — whoever holds it can
mint certificates the daemon trusts.

`agentmesh.yaml` on B — a mock profile first, so a failure here is a networking
failure and not an agent failure:

```yaml
workdir: ./state

profiles:
  - name: echo
    driver: mock
    mock: { reply: "pong from B", delayMs: 5 }

daemon:
  host: 0.0.0.0
  port: 8790
  tokenEnv: AGENTMESH_DAEMON_TOKEN     # the NAME; the secret stays in the environment
  allowCwd: [/srv/repos]               # required: remote tasks cannot run outside this
  tls:
    cert: ./certs/server.pem
    key: ./certs/server-key.pem
  auditPath: ./state/daemon-audit.ndjson
```

Windows B is the same file with Windows paths (`C:/agentmesh/state` — forward
slashes work and avoid YAML escaping).

## 2. Machine B: start the daemon

```bash
export AGENTMESH_DAEMON_TOKEN="$(openssl rand -hex 32)"   # note it down; A needs the same value
node dist/cli.js daemon --config agentmesh.yaml
# [agentmesh] worker daemon listening on https://0.0.0.0:8790 (https, profiles: echo)
```

From A (or from B itself), check it is alive before involving the master:

```bash
curl -k https://10.0.0.12:8790/healthz
# {"ok":true,"daemonId":"daemon-…","protocol":2}
```

> `-k` on purpose: the Windows `curl` is Schannel-based and ignores `--cacert`,
> so it cannot build a chain from your private CA. Where curl uses OpenSSL,
> `--cacert ./certs/ca.pem` verifies properly.

`/healthz` is unauthenticated and returns no data. Everything else needs
`Authorization: Bearer <token>`.

## 3. Machine A: point at B and run a task

```bash
export AGENTMESH_REMOTE_TOKEN='<the same 32-byte hex>'    # same secret, different name
```

`agentmesh.yaml` on A:

```yaml
workdir: ./state

profiles:
  - name: worker-echo
    driver: remote
    cwd: /srv/repos                    # a path ON B — see the note below
    remote:
      endpoint: https://10.0.0.12:8790
      tokenEnv: AGENTMESH_REMOTE_TOKEN
      remoteProfile: echo              # which profile on B to run
      ca: ./certs/ca.pem               # trust the private CA
      # cert: ./certs/client.pem       # uncomment both if B runs mTLS
      # key:  ./certs/client-key.pem
      resume: true                     # re-attach if the socket drops mid-run
```

Run one task, synchronously:

```bash
node dist/cli.js dispatch --profile worker-echo --task "hello from A"
```

```json
{
  "taskId": "7e199d7b-…",
  "profile": "worker-echo",
  "status": "completed",
  "text": "pong from machine B",
  "cwd": "/srv/repos"
}
```

**The `cwd` trap.** `cwd` on a remote profile is interpreted *on B*: it must be a
path that exists there and sits inside `daemon.allowCwd`. The default is the
master's own working directory, which almost never makes sense on the other host
and is refused with `cwd_not_whitelisted`. Set it explicitly, to B's path.

## 4. Swap the mock for the real pi agent

Install and authenticate pi on B first. `acpx` launches it as `npx pi-acp`,
which in turn needs the `pi` binary on `PATH`:

```bash
npm install -g @earendil-works/pi-coding-agent
pi                       # log in once, interactively; credentials land in ~/.pi
```

Then replace the profile on B (the daemon reads profiles at startup, so restart
it):

```yaml
profiles:
  - name: pi
    driver: acpx
    agent: pi                # acpx built-in -> `npx pi-acp`
    cwd: /srv/repos
```

A missing or unauthenticated `pi` fails inside the first turn, not at daemon
startup — the daemon only spawns it when a task arrives.

On A, edit the profile from step 3: rename it to `worker-pi` and point it at the
profile you just created (`remoteProfile: pi`). The name on A is yours to
choose; the value of `remoteProfile` is the name on B.

```bash
node dist/cli.js dispatch --profile worker-pi --task "add a /health endpoint and run the tests"
```

That proves the whole chain: A's orchestrator → TLS → B's daemon → acpx → pi
working in `/srv/repos`.

## 5. Machine A: attach Claude Code

Step 4 was A talking to B through the CLI, with no agent on A. The point of
agentmesh is the other shape: Claude Code on A decides what to delegate.

Register the MCP server with Claude Code — a project `.mcp.json` where you run
`claude`, or `claude mcp add` for another scope:

```json
{
  "mcpServers": {
    "agentmesh": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/ABS/PATH/agentmesh/dist/cli.js",
        "mcp",
        "--config",
        "/ABS/PATH/agentmesh/agentmesh.yaml"
      ],
      "env": { "AGENTMESH_REMOTE_TOKEN": "${AGENTMESH_REMOTE_TOKEN}" }
    }
  }
}
```

```bash
# equivalent one-liner, user scope
claude mcp add --scope user --transport stdio agentmesh -- \
  node /ABS/PATH/agentmesh/dist/cli.js mcp --config /ABS/PATH/agentmesh/agentmesh.yaml
```

Two things about that block:

- **absolute paths only.** Claude Code spawns the command from its own cwd, so
  `./dist/cli.js` and `./agentmesh.yaml` resolve to the wrong place. Check the
  entry with `claude mcp list`: a server that exits immediately shows as failed.
- **`${AGENTMESH_REMOTE_TOKEN}` is expanded by Claude Code** (in `.mcp.json`), so
  the secret stays in your shell (`export AGENTMESH_REMOTE_TOKEN='<hex>'` before starting
  `claude`) and never in the file.

Then just ask, in a normal Claude Code session:

> Have the pi worker on B add a `/health` endpoint to `/srv/repos/api` and run
> its test suite.

Claude Code calls `task_submit`, follows the task's events and reports the
worker's result. Ask it for the async shape — "start it, tell me when it is
done" — and it uses `task_wait` / `task_result` instead. Then keep going in the
same conversation:

> Now have it add a regression test for the bug it just fixed.

For B to actually *remember* the first turn, Claude Code has to reuse the same
worker: `spawn_worker` once, then pass that `workerId` to every `task_submit`.
One worker on B is one pi session, so "what you just fixed" resolves on the far
side. If it spawns a fresh worker instead, the second task still sees the files
(same `cwd`) but not the reasoning — and if turn one had run on A, even the files
would be on the wrong machine, which is what
`handoff: {fromTaskId, inject: "diff"}` is for
([`handoff.md`](./handoff.md#cross-host-handoff)). All five rules:
[`two-host.md`](./two-host.md#the-loop-dispatch-result-continue).

> The MCP server is a **child of the Claude Code session**: it lives and dies
> with it. A task still running when you quit `claude` loses the process that
> owned it (the record survives, the run does not). Let long jobs finish, or
> keep the same `mcp` server under a long-lived client.

## 6. If it does not work

| Symptom | Cause | Fix |
|---|---|---|
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | A trusts a different CA than the one that signed B's cert | point `remote.ca` at B's `ca.pem` |
| `ERR_TLS_CERT_ALTNAME_INVALID` | SAN does not cover the name in `endpoint` | regenerate with a SAN that matches what A dials |
| `401` on upgrade | tokens differ, or the env var is not in the daemon's environment | same secret, same variable name it is read from |
| `cwd_not_whitelisted` | `cwd` missing, or outside `daemon.allowCwd` | set `cwd` to a B-side path inside the whitelist |
| `EADDRINUSE` | another daemon already runs on that port | stop it, or change `daemon.port` |
| `alert certificate required` | B runs mTLS and A sent no client certificate | add `remote.cert` / `remote.key` |
| Task `cancelled` after a network blip | no grace window on B | set `daemon.orphanGraceMs` and `resume: true` |
| `claude mcp list` shows agentmesh as failed | relative path, or the config file is not there | absolute paths for both `dist/cli.js` and `agentmesh.yaml` |
| Claude Code says no agentmesh tools exist | server not started in this session | restart `claude` in the directory with the `.mcp.json`, then approve the server |

Full table, with the exact messages: [`troubleshooting.md`](./troubleshooting.md)
and [`deploy.md`](./deploy.md#7-troubleshooting).

## Next

- every key on both sides, OS by OS, plus a verification ladder and an
  operating checklist: [`two-host.md`](./two-host.md)
- CA, mTLS, firewall, boot-time start, rotation: [`deploy.md`](./deploy.md)
- attach a different master (OpenCode, Pi) and every CLI command:
  [`cli.md`](./cli.md)
- what the daemon actually does: [`remote.md`](./remote.md)
