# Quickstart: two machines, one task

Master on machine **A**, worker daemon on machine **B**, first delegated task
running end to end. Fifteen minutes if Node is already installed.

```
A — master                                    B — worker
┌───────────────────────────┐   WSS :8790    ┌──────────────────────────────┐
│ node dist/cli.js dispatch │ ─────────────▶ │ agentmesh daemon (TLS)       │
│ driver: remote profile    │ ◀───────────── │ local agent: opencode / mock │
└───────────────────────────┘    task events └──────────────────────────────┘
```

Only the worker needs an inbound port, and only the worker runs a coding agent.
The master never accepts connections; it dials out and streams events back.

## Contents

- [0. On both machines](#0-on-both-machines)
- [1. Machine B: certificates and config](#1-machine-b-certificates-and-config)
- [2. Machine B: start the daemon](#2-machine-b-start-the-daemon)
- [3. Machine A: point at B and run a task](#3-machine-a-point-at-b-and-run-a-task)
- [4. Swap the mock for a real agent](#4-swap-the-mock-for-a-real-agent)
- [5. If it does not work](#5-if-it-does-not-work)
- [Next](#next)

## 0. On both machines

```bash
git clone https://github.com/simtfer/agentmesh.git
cd agentmesh && npm ci && npm run build      # produces dist/cli.js
```

Requirements: **Node ≥ 22.13**; on B also `openssl` (Git Bash ships it on
Windows). Every command below is `node dist/cli.js …`; `npm link` gives you a
plain `agentmesh` if you prefer.

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

## 4. Swap the mock for a real agent

On B, replace the profile (the daemon reads profiles at startup, so restart it):

```yaml
profiles:
  - name: opencode
    driver: acpx
    agent: opencode          # must be installed and authenticated on B
    cwd: /srv/repos
```

On A, `remoteProfile: opencode` on the remote profile — the profile name on A is
yours to choose, the value of `remoteProfile` is the name on B.

```bash
node dist/cli.js dispatch --profile worker-opencode --task "add a /health endpoint and run the tests"
```

For real orchestration (async, approvals, multiple workers) start `mcp` on A and
attach it to OpenCode or Pi — that is what the master agent talks to:
[`cli.md`](./cli.md).

## 5. If it does not work

| Symptom | Cause | Fix |
|---|---|---|
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | A trusts a different CA than the one that signed B's cert | point `remote.ca` at B's `ca.pem` |
| `ERR_TLS_CERT_ALTNAME_INVALID` | SAN does not cover the name in `endpoint` | regenerate with a SAN that matches what A dials |
| `401` on upgrade | tokens differ, or the env var is not in the daemon's environment | same secret, same variable name it is read from |
| `cwd_not_whitelisted` | `cwd` missing, or outside `daemon.allowCwd` | set `cwd` to a B-side path inside the whitelist |
| `EADDRINUSE` | another daemon already runs on that port | stop it, or change `daemon.port` |
| `alert certificate required` | B runs mTLS and A sent no client certificate | add `remote.cert` / `remote.key` |
| Task `cancelled` after a network blip | no grace window on B | set `daemon.orphanGraceMs` and `resume: true` |

Full table, with the exact messages: [`troubleshooting.md`](./troubleshooting.md)
and [`deploy.md`](./deploy.md#7-troubleshooting).

## Next

- every key on both sides, OS by OS, plus a verification ladder and an
  operating checklist: [`two-host.md`](./two-host.md)
- CA, mTLS, firewall, boot-time start, rotation: [`deploy.md`](./deploy.md)
- what the daemon actually does: [`remote.md`](./remote.md)
