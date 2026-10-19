# Two hosts: configuring and starting A (master) and B (worker)

[`quickstart.md`](./quickstart.md) gets one task across the network in fifteen
minutes. This page is the reference for the same setup when you need to
understand every knob, run it on Linux *or* Windows, start it at boot, and tell
the difference between "the software is broken" and "the deployment is broken".

Production hardening (private CA, mutual TLS, firewall, rotation, systemd) has
its own runbook: [`deploy.md`](./deploy.md). This page covers configuration and
startup on both hosts, and links there for the operating procedure.

Concrete roles, used in every example below: **A is Claude Code** (the master —
an MCP client), **B is pi** (the worker — an ACP agent driven by `acpx`). Nothing
here depends on that pair; swap either side's agent and only the config changes.

## Contents

- [Topology and trust boundaries](#topology-and-trust-boundaries)
- [What each host needs](#what-each-host-needs)
- [Machine B: the worker](#machine-b-the-worker)
- [Machine A: the master](#machine-a-the-master)
- [The loop: dispatch, result, continue](#the-loop-dispatch-result-continue)
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
│ Claude Code (MCP client)       │  WSS :8790   │ agentmesh daemon                 │
│ node dist/cli.js mcp           │ ───────────▶ │  HTTP  /healthz  /profiles       │
│ profile: driver: remote        │              │  WS    /ws  (typed task events)  │
│ token from env, no inbound     │ ◀─────────── │  TLS (+ mTLS), bearer token      │
│ port                           │  events      │ local ACP agent: pi (acpx) ─▶ ACP│
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
| the agent itself | **Claude Code** (`claude` on `PATH`), attached over stdio MCP | **pi**, installed and logged in; `acpx` drives it as `npx pi-acp` |
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

### The agent: pi

```bash
npm install -g @earendil-works/pi-coding-agent   # provides the `pi` binary
sudo -u agentmesh -H pi                          # log in once, as the daemon's user
```

`acpx` launches `npx pi-acp`, which drives that binary. Two consequences worth
knowing before the first task: `pi` must be on the **daemon account's** `PATH`,
and it must be logged in **as that account** — credentials live under `~/.pi`,
so an agent installed and authenticated as your own user is invisible to a
daemon running as `agentmesh`. The failure surfaces inside the first turn as an
agent error, not at startup.

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
  - name: pi                       # the name A refers to as remoteProfile
    driver: acpx
    agent: pi                      # acpx built-in -> `npx pi-acp`
    cwd: /srv/repos                # default working dir for this profile on B
    session: pi-main               # optional: one long-lived conversation, resumed after a restart
    # worktree: true               # isolate each task in a worktree — the opposite trade-off;
                                   # cannot be combined with `session`

daemon:
  host: 0.0.0.0                    # default 127.0.0.1 — must be reachable from A
  port: 8790                       # default 8787
  tokenEnv: AGENTMESH_DAEMON_TOKEN # env var NAME; never the secret itself
  allowCwd: [/srv/repos]           # required: remote tasks may not run outside these
  exposeProfiles: [pi]             # optional; defaults to every non-remote profile
  orphanGraceMs: 30000             # default 0 — keep a dropped task alive this long
  workerIdleMs: 1800000            # default 30 min — how long a reused worker lives
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
- **`worktree: true`** puts each task in its own worktree branched from the repo's
  HEAD. Right for parallel *write* tasks; for a chain, only a *reused* worker keeps
  it coherent, and releasing that worker deletes the worktree — commit first.
  See [The loop](#the-loop-dispatch-result-continue).
- **`workerIdleMs`** bounds a conversation. A reused worker is a live, logged-in
  agent on this host; `0` means "keep it until the daemon stops", the default 30
  minutes means an abandoned master costs you half an hour of that, not forever.
- **`session`** pins the profile to one named conversation, stored on B and
  resumed by the next turn under that name — including after a daemon restart or
  an agent crash. It implies a fixed `cwd` (a session that moves cannot resume)
  and one live worker of that profile at a time. Leave it out for fan-out work.
  See [The loop](#the-loop-dispatch-result-continue).
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
# [agentmesh] worker daemon listening on https://0.0.0.0:8790 (https, profiles: pi)
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
# {"daemonId":"daemon-…","profiles":["pi"]}
```

## Machine A: the master

A needs no inbound port, no worker agent, and no daemon. It needs the same build,
a profile that points at B, and Claude Code if you want an agent driving it.

```bash
git clone https://github.com/simtfer/agentmesh.git && cd agentmesh
npm ci && npm run build
export AGENTMESH_REMOTE_TOKEN='<the 32-byte hex from B>'
```

```yaml
workdir: ./state

profiles:
  - name: worker-pi                # your name for this worker; used in task_submit
    driver: remote
    cwd: /srv/repos                # a path ON B — see the next section
    remote:
      endpoint: https://10.0.0.12:8790   # https:// here; wss:// is derived
      tokenEnv: AGENTMESH_REMOTE_TOKEN
      remoteProfile: pi            # the profile name on B; defaults to this profile's name
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

Two ways to drive it.

**From the CLI** — enough to prove the chain without an agent on A:

```bash
node dist/cli.js dispatch --profile worker-pi --task "run the test suite"
```

**From Claude Code** — the shape that gives A a mind of its own. Claude Code
starts `dist/cli.js mcp` as a stdio server and then calls the tools itself:

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
# same thing without the file, at user scope
claude mcp add --scope user --transport stdio agentmesh -- \
  node /ABS/PATH/agentmesh/dist/cli.js mcp --config /ABS/PATH/agentmesh/agentmesh.yaml
```

Put the JSON in `.mcp.json` where you run `claude` (project scope, so it travels
with the directory) or let `claude mcp add` write it elsewhere. Then, in a session:
*"have the pi worker on B run the test suite in /srv/repos/api and fix what
fails."* Claude Code does the rest with `task_submit` / `task_wait`, reads the
result, and decides the next task — [the loop](#the-loop-dispatch-result-continue)
in the next section.

Three properties of that arrangement are worth stating plainly, because they
explain most "it stopped" reports:

- **Absolute paths.** The server is spawned from Claude Code's own cwd;
  `./dist/cli.js` and `./agentmesh.yaml` silently point somewhere else.
- **The secret stays out of the file.** In `.mcp.json`, Claude Code expands
  `${AGENTMESH_REMOTE_TOKEN}` from the environment, so export it in the shell that launches
  `claude` (`~/.bashrc` / `setx`). A literal token in `.mcp.json` is a token in
  a repo.
- **The server is a child of the session.** Quit `claude` and the process that
  owned the orchestrator goes with it: records stay in A's SQLite file, but the
  run that was executing does not survive. For a job that must outlive the
  session, keep the same `mcp` server under a long-lived client instead.

Approvals are the one thing that only works through the resident mode. A pending
approval lives in the orchestrator that owns the running task, so a second CLI
process cannot answer it: `dispatch` on a task that needs permission parks in
`waiting` until the task timeout (ten minutes by default) and then ends
`timed_out`. Claude Code answers with `task_approve`, because that is the same
process that submitted.

## The loop: dispatch, result, continue

The master is the scheduler: you talk to it, it decomposes the work, it dispatches
to B, and it decides what happens next. What B *is* during that loop is a choice:

- **A fresh worker per task** (the default). B gets a new agent process each time,
  so nothing the previous task learned survives.
- **One worker for many turns** — `spawn_worker` once, then `task_submit` with that
  `workerId`. The daemon keeps the worker, and therefore its ACP session and its
  context, alive between tasks. That is the "A keeps talking to B" shape.
- **A pinned session** — give the profile a `session` name, or pass `sessionKey` on
  the submit. The conversation is stored under that name on B, so it outlives the
  worker *and* the daemon process: the next turn under the same key resumes it.

```
Claude Code (A)                                    daemon (B)
  spawn_worker {profile: worker-pi}  ----------->  pi (worker w-8f2c)
  task_submit {workerId, "run the tests"}  ------>  same session
  <------------------------------------------  result
  task_submit {workerId, "now fix what failed"} ->  same session, still remembers
  <------------------------------------------  result
  kill_worker {workerId}  ---------------------->  released
```

Reuse lasts as long as the handle: `kill_worker` releases it, and the daemon
reaps a conversation idle for `daemon.workerIdleMs` (default 30 minutes). Both
are deliberate — a reused worker is a whole agent process, authenticated on that
host. A second turn submitted while the first is still running is refused with
`worker_ref_busy`, so the master waits for its own task rather than interleaving
two prompts into one session.

A pinned session trades that handle for a name, and gets restart survival:

```yaml
- name: worker-pi
  driver: acpx
  agent: pi
  cwd: /srv/projects/demo        # fixed: a session that moves cannot resume
  session: pi-main               # the conversation's name on this host
```

```
  task_submit {profile: worker-pi, "read the failing test"}  -->  pi (session pi-main)
  <--------------------------------------------------------  result
  ... B restarts: daemon, agent process, everything ...
  task_submit {profile: worker-pi, "now fix it"}            -->  pi, same session, remembers
  <--------------------------------------------------------  result
```

`session` is per profile, so it also means one live worker of that profile at a
time. Use `workerId` when you want to reuse a worker you just talked to; use a
`session` when the conversation has to survive A restarting, B restarting, or
another master taking over. See
[`remote.md`](./remote.md#conversations-one-worker-many-turns) for the wire-level
rules, and note that a pinned session cannot be combined with `worktree: true`.

Five rules decide whether turn two actually continues turn one.

1. **Reusing the worker is what keeps the conversation.** With a reused
   `workerId`, B's agent sees its own previous turn — including files it wrote,
   tool output it read, and what it decided. Without one, every task is a new
   agent reading a prompt that must stand on its own.
2. **A fresh worker sees the checkout, not the chat.** Two tasks in the same
   `cwd` still see the same files, so *"now add a regression test for what you
   just fixed"* works even without reuse — as long as the edits are on disk. What
   does not transfer is anything the agent only knew from the conversation.
3. **`worktree: true` holds while you reuse the worker, and only then.** A reused
   worker keeps its own worktree, so its turns stay coherent. The moment you
   start a fresh worker it branches from the repo's HEAD and cannot see the
   predecessor's uncommitted work — and `kill_worker` deletes the worktree, so
   release after committing, not before. A pinned session refuses `worktree` for
   the same reason: a new worktree path every spawn would never resume.
4. **Cross-host continuation is explicit.** If turn one ran on A and turn two runs
   on B, the patch is on the wrong machine: pass
   `handoff: {fromTaskId, inject: "diff"}` and it travels as bytes, or
   `inject: "result"` to inline the text. `base: "predecessor"` is refused for a
   remote successor — a commit object does not cross a host boundary.
   [`handoff.md`](./handoff.md#cross-host-handoff).
5. **`resume: true` is about the socket, not the agent.** It re-attaches the
   event stream after a dropped connection. It does not keep a session alive
   between tasks by itself, and a `workerRef` does not survive a daemon restart.
   What survives is the *stored session* behind a pinned `sessionKey`: after a
   restart the next turn under that key resumes it, while a ref-only submit is
   refused (`worker_ref_unknown`) rather than silently starting over.

If the next step depends on *what* came back, give the task an `outputSchema`
([`contracts.md`](./contracts.md)): the verdict arrives as `structured`, so the
master branches on data instead of parsing prose out of the final text.

Two profiles are worth having on A rather than one clever one: `worker-pi` for
chains (one reused worker in a shared `cwd`) and `worker-pi-fanout` with
`worktree: true` on B for independent parallel writes.

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
| 4 | the agent works | `dispatch` with the real `pi` profile | a real answer, and B's audit log gets `submit_ok` |
| 5 | mTLS works | dispatch without `remote.cert`, then with it | first fails with `alert certificate required`, second succeeds |
| 6 | a drop is survivable | kill the socket mid-run (`orphanGraceMs` > 0, `resume: true`) | the task finishes; events are replayed, not duplicated |
| 7 | a conversation survives | two `task_submit`s with the same `workerId`, then `agent_inspect` on B | one worker, two tasks — the second turn still had the first in context |

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
| B runtime | `worker_ref_unknown` | the conversation expired (`workerIdleMs`) or was released | drop the `workerId` and spawn a new worker; the session is gone |
| B runtime | `worker_ref_busy` | a turn on that worker is still running | `task_wait` for it; one session takes one prompt at a time |
| B runtime | `worker_ref_cwd_mismatch` | a reused worker was asked to move directory | a conversation keeps its `cwd`; `kill_worker` and start elsewhere |
| B runtime | `session_key_mismatch` | a `workerRef` was paired with a different `sessionKey` | a worker's session name is fixed at creation; drop the ref to start another conversation |
| B audit | `tls_reject` with `peer did not return a certificate` | mTLS on, A sent no client cert | add `remote.cert`/`remote.key` |
| A | `401` on upgrade | token mismatch | same secret on both sides |
| A | `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | A trusts a different CA | point `remote.ca` at B's `ca.pem` |
| A | `ERR_TLS_CERT_ALTNAME_INVALID` | SAN does not cover what `endpoint` dials | regenerate the certificate |
| A | `ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED` | B runs mTLS, A is certless | same as the `tls_reject` row |
| A | `connect ECONNREFUSED` | nothing listening, or a firewall drop | check rung 1 of the ladder |
| A | task ends `cancelled` after a blip | `orphanGraceMs: 0` or `resume: false` | grace window + resume |
| A (Claude Code) | server shows as failed in `claude mcp list` | the stdio command exits: relative path, missing config, or a `node` that is not on Claude's `PATH` | absolute paths; run the same command by hand to see its stderr |
| A (Claude Code) | the tools exist but every remote submit fails with `401` | the session's environment has no `AGENTMESH_REMOTE_TOKEN` | export it where `claude` is launched, or use `${AGENTMESH_REMOTE_TOKEN}` in `env` |

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
- The master side was exercised through the same stdio MCP surface Claude Code
  attaches to (`npm run smoke` drives it over a real pipe: full task lifecycle,
  approvals included), and against real `pi` and `opencode` workers on one host
  (`npm run real`). **Not** verified: a Claude Code session driving this stack
  end to end — the wiring above is the standard stdio MCP entry, but treat it as
  untested until you have seen `claude mcp list` report it healthy.
- **A pinned session was verified against real `pi`, not just mock.** Two turns
  were sent to one `sessionKey`; the daemon was then stopped, a new one started
  from the same `workdir`, and the same key sent a third turn. pi answered with
  the value it had been told two lifetimes earlier (`417`), and its ACP session
  id was identical before and after. What that exercises: the session record on
  B's disk, the `resume` path through acpx, and the client's `sessionKey` wire
  field. What it does not: two physical machines, or a pi that has logged out in
  between.
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
