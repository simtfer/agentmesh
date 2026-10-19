# Two hosts: configuring and starting A (master) and B (worker)

[`quickstart.md`](./quickstart.md) gets one task across the network in fifteen
minutes. This page is the reference for the same setup when you need to
understand every knob, run it on Linux *or* Windows, start it at boot, and tell
the difference between "the software is broken" and "the deployment is broken".

Production hardening (private CA, mutual TLS, firewall, rotation, systemd) has
its own runbook: [`deploy.md`](./deploy.md). This page covers configuration and
startup on both hosts, and links there for the operating procedure.

## Contents

- [Topology and trust boundaries](#topology-and-trust-boundaries)
- [What each host needs](#what-each-host-needs)
- [Machine B: the worker](#machine-b-the-worker)
- [Machine A: the master](#machine-a-the-master)
- [The `cwd` contract](#the-cwd-contract)
- [Verification ladder](#verification-ladder)
- [Starting it at boot](#starting-it-at-boot)
- [Operating it](#operating-it)
- [Diagnosis table](#diagnosis-table)
- [Security checklist](#security-checklist)
- [What has been verified](#what-has-been-verified)
- [Where to read next](#where-to-read-next)

## Topology and trust boundaries

```
machine A — master                              machine B — worker
┌────────────────────────────────┐              ┌──────────────────────────────────┐
│ orchestrator (SQLite)          │  WSS :8790   │ agentmesh daemon                 │
│ MCP server (opencode / pi)     │ ───────────▶ │  HTTP  /healthz  /profiles       │
│ profile: driver: remote        │              │  WS    /ws  (typed task events)  │
│ token from env, no inbound     │ ◀─────────── │  TLS (+ mTLS), bearer token      │
│ port                             │  events     │  local ACP agents (acpx) ──▶ ACP│
└────────────────────────────────┘              └──────────────────────────────────┘
```

What crosses the wire: typed control messages (`submit`, `approve`, `respond`,
`cancel`, `attach`, `query`) and task events. What does **not**: an ACP stdio
bridge. The agent process is spawned by the daemon, on B, and never speaks to A
directly.

Two consequences worth internalising before you configure anything:

- **A holds the queue, B holds the agent.** Retries, budgets, DAG gating and the
  task store are A's; the working tree, the tool execution and the secrets the
  agent can read are B's.
- **B is the security boundary.** Everything that makes a remote worker safe —
  `allowCwd`, the token, TLS, mTLS — is enforced on B. A is the caller.

## What each host needs

| | machine A (master) | machine B (worker) |
|---|---|---|
| Node.js | ≥ 22.13 | ≥ 22.13 |
| agentmesh build | `dist/cli.js` | `dist/cli.js` |
| an ACP agent (opencode / pi) | not required on A; needed wherever the master agent runs | **required** for real work (a `driver: mock` profile needs nothing) |
| `openssl` | only to inspect certificates | yes, to generate the CA/certificates |
| inbound port | **none** | TCP 8790 (or whatever `daemon.port` says) |
| outbound | → B:8790 | → whatever the agent talks to |
| git | for the clone | for the clone, and for `worktree: true` profiles |

Both hosts must run the same agentmesh version: the protocol is numbered, and a
daemon too old for a feature refuses it at the handshake instead of half-way
through.

## Machine B: the worker

### Install, and give the daemon its own account

```bash
git clone https://github.com/simtfer/agentmesh.git /srv/agentmesh
cd /srv/agentmesh && npm ci && npm run build
sudo useradd --system --create-home --home-dir /var/lib/agentmesh agentmesh
sudo mkdir -p /srv/repos && sudo chown agentmesh: /srv/repos
```

On Windows there is no build step difference: `git clone`, `npm ci`,
`npm run build`, then run `node dist\cli.js`. Use a dedicated local user rather
than `SYSTEM` if the host is shared — the daemon inherits the account's file
access, and so does every agent it spawns.

### Certificates

A non-loopback bind without TLS is refused (`insecure_bind`), so there is no
"just try it first" that skips this step.

```bash
bash deploy/certs/make-certs.sh --out /etc/agentmesh/certs \
  --san "DNS:worker.internal,IP:10.0.0.12"
```

The SAN is the part that fails in practice: a certificate for
`worker.internal` is useless if A dials `https://10.0.0.12:8790`. Put **every**
name and address A might use in the list. The script writes:

| file | who needs it | purpose |
|---|---|---|
| `ca.pem` | both hosts | the trust root; A verifies B with it |
| `ca-key.pem` | nobody at runtime | **can mint trusted certificates — keep it offline** |
| `server.pem` / `server-key.pem` | B | the daemon's identity |
| `client.pem` / `client-key.pem` | A | only used when B runs mutual TLS |

`--no-client` skips the client pair when you are not using mTLS. Validity
defaults to 825 days; check it with
`openssl x509 -in server.pem -noout -enddate`.

### Configuration

`agentmesh.yaml` on B. Every key in the `daemon:` block:

```yaml
workdir: /var/lib/agentmesh        # task store, worktrees, staged handoff patches

profiles:
  - name: opencode                 # the name A refers to as remoteProfile
    driver: acpx
    agent: opencode
    cwd: /srv/repos                # default working dir for this profile on B
    worktree: true                 # isolate each task in a git worktree (optional)

daemon:
  host: 0.0.0.0                    # default 127.0.0.1 — must be reachable from A
  port: 8790                       # default 8787
  tokenEnv: AGENTMESH_DAEMON_TOKEN # env var NAME; never the secret itself
  allowCwd: [/srv/repos]           # required: remote tasks may not run outside these
  exposeProfiles: [opencode]       # optional; defaults to every non-remote profile
  orphanGraceMs: 30000             # default 0 — keep a dropped task alive this long
  tls:
    cert: /etc/agentmesh/certs/server.pem
    key: /etc/agentmesh/certs/server-key.pem
    ca: /etc/agentmesh/certs/ca.pem      # presence turns on mutual TLS
  auditPath: /var/lib/agentmesh/daemon-audit.ndjson   # default <workdir>/daemon-audit.ndjson
  auditMaxBytes: 10485760          # default 10 MiB; 0 disables rotation
  auditKeep: 5                     # default 5 archives
```

Why each of the load-bearing ones exists:

- **`allowCwd` is mandatory, not a nicety.** Empty or absent means every remote
  task is refused (`cwd_not_whitelisted`). It is what stops a master from
  running an agent in your home directory; comparison is by path segment, so
  `/srv/repos_evil` does not match `/srv/repos`.
- **`exposeProfiles`** narrows what a remote caller can ask for. Without it the
  daemon advertises every profile that is not itself `driver: remote` — including
  ones that can reach other machines.
- **`orphanGraceMs`** decides what a network blip means. `0` (the default)
  cancels the task the moment the socket closes, which is honest but wasteful;
  a grace window lets A re-attach (`resume: true`) and keep the same run.
- **`tls.ca`** is the mTLS switch. Present ⇒ the daemon requires a client
  certificate signed by that CA at the handshake, before any request is parsed.
- **`workdir`** is B's state, not A's: the task store, worktrees and
  `<workdir>/handoffs/` for staged patches all live here. It does not have to be
  inside `allowCwd`.

### The token

```bash
printf 'AGENTMESH_DAEMON_TOKEN=%s\n' "$(openssl rand -hex 32)" \
  | sudo tee /etc/agentmesh/worker.env >/dev/null
sudo chmod 600 /etc/agentmesh/worker.env
```

The same value goes into A's environment. `tokenEnv` also accepts several
comma-separated variable names, and each variable can hold several
comma-separated values, which is what makes token rotation (below)
zero-downtime. The daemon refuses to start with an empty token set
(`no_token`) rather than come up unauthenticated.

Windows: `setx /M AGENTMESH_DAEMON_TOKEN "<hex>"` sets a machine variable the
Task Scheduler job can read; the wrapper script refuses to start without it.

### Start

```bash
# foreground, which is what you want the first time
sudo -u agentmesh env $(sudo cat /etc/agentmesh/worker.env) \
  node /srv/agentmesh/dist/cli.js daemon --config /etc/agentmesh/agentmesh.yaml
# [agentmesh] worker daemon listening on https://0.0.0.0:8790 (https, profiles: opencode)
```

Flags override the config for a one-off test: `--host`, `--port`, `--token-env`,
`--tls-cert`, `--tls-key`, `--tls-ca`, `--orphan-grace-ms`, `--allow-insecure`
(never on a shared network — it puts an agent controller in cleartext).

Signals: `SIGINT`/`SIGTERM` shut down cleanly (the audit stream is flushed and
closed); `SIGHUP` re-reads the accepted tokens from the environment.

Two probes, deliberately different:

```bash
curl -k https://10.0.0.12:8790/healthz                  # no auth: {ok, daemonId, protocol}
curl -k -H "Authorization: Bearer $TOK" https://10.0.0.12:8790/profiles
# {"daemonId":"daemon-…","profiles":["opencode"]}
```

## Machine A: the master

A needs no inbound port, no agent, and no daemon. It needs the same build and a
profile that points at B.

```bash
git clone https://github.com/simtfer/agentmesh.git && cd agentmesh
npm ci && npm run build
export AGENTMESH_REMOTE_TOKEN='<the 32-byte hex from B>'
```

```yaml
workdir: ./state

profiles:
  - name: worker-opencode          # your name for this worker; used in task_submit
    driver: remote
    cwd: /srv/repos                # a path ON B — see the next section
    remote:
      endpoint: https://10.0.0.12:8790   # https:// here; wss:// is derived
      tokenEnv: AGENTMESH_REMOTE_TOKEN
      remoteProfile: opencode      # the profile name on B; defaults to this profile's name
      ca: /etc/agentmesh/ca.pem    # trust B's private CA
      cert: /etc/agentmesh/client.pem      # required only when B runs mTLS
      key: /etc/agentmesh/client-key.pem
      connectTimeoutMs: 15000      # default 15000; the WS handshake budget
      resume: true                 # re-attach automatically after a mid-run drop
      reconnectAttempts: 3         # default 3
      reconnectDelayMs: 500        # default 500
```

`cert`/`key`/`ca` accept a path or an inline PEM block, on both sides. A path
that cannot be read fails immediately with `tls_invalid` instead of surfacing as
an opaque handshake error on the other machine.

Two ways to drive it:

```bash
# synchronous: submit and wait for the terminal result (what the quickstart uses)
node dist/cli.js dispatch --profile worker-opencode --task "run the test suite"

# resident: the MCP surface a real master agent attaches to
node dist/cli.js mcp --config agentmesh.yaml
```

Approvals only work through the resident mode. A pending approval lives in the
orchestrator that owns the running task, so a second CLI process cannot answer
it: `dispatch` on a task that needs permission parks in `waiting` until the task
timeout (ten minutes by default) and then ends `timed_out`. Attach the master to
`mcp` and answer with `task_approve`.

## The `cwd` contract

This is the single most common two-host failure, and it is not a bug.

`cwd` on a remote profile is a path **on B**, even though it is written in A's
config file. The daemon resolves it and checks it against `daemon.allowCwd`
before the worker starts:

| what A sends | what B does |
|---|---|
| `cwd: /srv/repos` and B's `allowCwd: [/srv/repos]` | runs there |
| `cwd: /srv/repos` and B's `allowCwd: [/srv/work]` | refuses: `working directory not in whitelist: /srv/repos (cwd_not_whitelisted)` |
| nothing set — A's own working directory is used | usually refused, because A's `/home/me/proj` does not exist on B |
| `../repos` or `/srv/repos/../..` | resolved first, then checked: cannot escape a root |

So: always set `cwd` explicitly on a remote profile, to a path inside B's
whitelist. When the same job may run on either host, give the two profiles
different `cwd` values rather than trying to make one string work in both.

## Verification ladder

Climb these in order. Each rung removes half the remaining unknowns, and a
failure at rung *n* means everything below it is fine.

| # | what | command | expect |
|---|---|---|---|
| 1 | the wire works | `curl -k https://<B>:8790/healthz` | `{"ok":true,…}` — no auth needed |
| 2 | the token works | `curl -k -H "Authorization: Bearer $TOK" https://<B>:8790/profiles` | the profile list; without the header, `401` |
| 3 | the TLS trust works | `dispatch` with a `driver: mock` profile | `"status": "completed"` |
| 4 | the agent works | `dispatch` with the real `acpx` profile | a real answer, and B's audit log gets `submit_ok` |
| 5 | mTLS works | dispatch without `remote.cert`, then with it | first fails with `alert certificate required`, second succeeds |
| 6 | a drop is survivable | kill the socket mid-run (`orphanGraceMs` > 0, `resume: true`) | the task finishes; events are replayed, not duplicated |

Rungs 1–5 were run end to end over TLS with a private CA on one machine before
this page was written; rung 6 is covered by `test/remote.test.ts`. See
[what has been verified](#what-has-been-verified) for the honest limits.

## Starting it at boot

Linux, with the unit in this repo (it assumes `/srv/agentmesh` and a service
account named `agentmesh`):

```bash
sudo cp deploy/systemd/agentmesh-worker.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now agentmesh-worker
systemctl status agentmesh-worker
```

The unit's `ReadWritePaths` must cover `workdir` **and** every `allowCwd` root,
otherwise the agent cannot write to the repository it was hired to change.

Windows, without extra software:

```bat
setx /M AGENTMESH_DAEMON_TOKEN "<hex>"
schtasks /create /tn "agentmesh worker" /tr "C:\agentmesh\deploy\windows\run-worker.cmd" ^
         /sc onstart /ru SYSTEM /rl HIGHEST /f
schtasks /run /tn "agentmesh worker"
```

The wrapper logs to `daemon.out.log` and does not rotate it; the rotated,
security-relevant log is the audit trail. Use NSSM or WinSW if you want stdout
rotation too.

Start order does not matter — A dials B per turn — but B must be up before A's
first task, and A's `dispatch` will fail loudly (`connection refused`) rather
than queue silently.

## Operating it

**Two logs, rotated differently.** The audit trail (`daemon.auditPath`, NDJSON:
auth, submits and their verdicts, approvals, cancels, attaches, TLS refusals,
token reloads) rotates by size in-process. stdout/stderr only carries startup
and shutdown notices, and belongs to systemd/journald or the operator.

**Restart semantics.** The agent process is a child of the daemon, so restarting
B ends whatever was running there: the task record survives in B's store, but the
turn does not. A graceful `SIGTERM` with no grace window cancels in-flight tasks
as it closes each socket (`cancelled`); with `orphanGraceMs > 0` the record is
left as it stands, because that window assumed the daemon would still be up. After
a hard kill the record is simply left where it was. Either way a master should
read a non-terminal record after a daemon restart as *unknown*
(`queryRemoteTask`) and re-submit, rather than wait for a result that will never
arrive. The `orphanGraceMs` window is for a **dropped socket**, not for a
restart — it keeps the task alive while the same daemon is still running.
Restarting A loses no history either (its store is A's SQLite file), but the
turns A was executing end with the process.

**Token rotation** (no downtime):

```bash
# 1. add the new secret next to the old one, same variable, comma-separated
AGENTMESH_DAEMON_TOKEN="<old>,<new>"
# 2. reload B, then move A's clients to <new>, then reload B again with only <new>
kill -HUP <daemon pid>        # or: systemctl reload agentmesh-worker
```

Reload refuses an empty set, so a typo cannot make the daemon unauthenticated or
lock you out.

**Certificate rotation** is a restart: ship the new `server.pem`/`server-key.pem`
(or `client.*` on A), restart, and the affected window is only new connections.

**Ports and firewall.** One direction only: A → B on `daemon.port`. Pin the
source address; the token and mTLS are defence in depth, not a substitute for a
firewall rule. Linux (`ufw`/`firewalld`) and Windows
(`New-NetFirewallRule`) one-liners are in
[`deploy.md`](./deploy.md#3-firewall).

## Diagnosis table

Messages below are the ones the code actually emits.

| where | message | meaning | fix |
|---|---|---|---|
| B startup | `refusing to bind non-loopback host "0.0.0.0" without TLS` (`insecure_bind`) | no `daemon.tls` | configure cert/key |
| B startup | `daemon requires a bearer token …` (`no_token`) | `tokenEnv` unset, or the variable is empty in the service environment | put the secret in the unit's `EnvironmentFile` |
| B startup | `EADDRINUSE` | another daemon already listens on that port | stop it or change `daemon.port` |
| B startup | `tls_invalid` | cert/key/ca path unreadable, or not a PEM block | fix path and permissions |
| B runtime | `working directory not in whitelist: … (cwd_not_whitelisted)` | A's `cwd` is not inside `allowCwd` | align the two |
| B runtime | `profile_not_allowed` | `remoteProfile` not exposed | add it to `exposeProfiles` |
| B audit | `tls_reject` with `peer did not return a certificate` | mTLS on, A sent no client cert | add `remote.cert`/`remote.key` |
| A | `401` on upgrade | token mismatch | same secret on both sides |
| A | `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | A trusts a different CA | point `remote.ca` at B's `ca.pem` |
| A | `ERR_TLS_CERT_ALTNAME_INVALID` | SAN does not cover what `endpoint` dials | regenerate the certificate |
| A | `ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED` | B runs mTLS, A is certless | same as the `tls_reject` row |
| A | `connect ECONNREFUSED` | nothing listening, or a firewall drop | check rung 1 of the ladder |
| A | task ends `cancelled` after a blip | `orphanGraceMs: 0` or `resume: false` | grace window + resume |

More codes: [`troubleshooting.md`](./troubleshooting.md). The daemon's audit
trail is the first place to look for "who tried what" — refusals record the peer
address and, for auth failures, a 12-hex fingerprint of the presented token,
never the token.

## Security checklist

Before B is reachable from anything but A:

- [ ] `daemon.allowCwd` lists exactly the roots the agent may touch — no `/`,
      no `$HOME`, no parent of everything
- [ ] TLS on; SAN covers the address A dials; `ca-key.pem` is not on B
- [ ] mTLS on if the network is shared or the token lives anywhere people can read
- [ ] the token is in an env var with 0600 permissions, never in `agentmesh.yaml`
      or the repo
- [ ] the firewall admits only A → `daemon.port`
- [ ] the daemon runs as a dedicated account, and the systemd
      `ReadWritePaths` match `allowCwd`
- [ ] the audit trail is rotated (`auditMaxBytes` > 0) and somewhere you actually read
- [ ] you accept the blast radius: an authenticated caller can run tools as that
      account. Treat the token like an SSH key, because that is what it is.

## What has been verified

Stated plainly, because "it works" is not one claim:

- `npm run deploy:tls` runs the whole stack over a **real network interface** of
  one machine (its LAN address, not loopback), including the failure modes: a
  master trusting the wrong CA, a plaintext bind on a reachable interface, and
  mTLS with a missing or foreign client certificate.
- The configuration on this page was executed as written — TLS with a private
  CA, mTLS on and off, the whitelist refusal, the wrong-token refusal — on
  Windows, both processes on one host.
- **Not** covered: two physical machines. DNS, routing and the worker's firewall
  are exactly what the checklist above is for, and they are the steps that fail
  first in practice. macOS is untested.

Per-test detail: [`verification.md`](./verification.md).

## Where to read next

| | |
|---|---|
| [`quickstart.md`](./quickstart.md) | the fifteen-minute version of this page |
| [`deploy.md`](./deploy.md) | CA, mTLS, firewall, systemd, rotation, in operator order |
| [`remote.md`](./remote.md) | what the daemon does, and the client API for re-attaching |
| [`configuration.md`](./configuration.md) | reference for every key in `agentmesh.yaml` |
| [`troubleshooting.md`](./troubleshooting.md) | error codes across the whole system |
