# Remote Worker Daemon (cross-machine workers)

Run workers on another machine — a GPU box, a build server, a colleague's
checkout — without ever putting an ACP stdio bridge on the network. The daemon
wraps the **same** local stack (Orchestrator + TaskManager + acpx drivers) behind
an authenticated HTTP+WebSocket endpoint; on the master side a remote worker is
just another `driver: remote` profile, so dispatch, approvals, events and
persistence behave identically to a local worker.

```
master (machine A)                                  worker daemon (machine B)
┌───────────────────┐   WSS + Bearer token   ┌──────────────────────────────────┐
│ driver: remote     │ ─────────────────────▶ │ agentmesh daemon                 │
│  profile ──────────┼── submit/approve/… ───▶│  • HTTP /healthz, /profiles      │
│ RemoteWorkerDriver │ ◀───────────────────── │  • WS /ws  (typed task events)   │
└───────────────────┘   task events, result   │  • local Orchestrator + acpx     │──▶ ACP stdio (LOCAL ONLY)
                                              └──────────────────────────────────┘
```

## Contents

- [Start the daemon (machine B)](#start-the-daemon-machine-b)
- [Point a master at it (machine A)](#point-a-master-at-it-machine-a)
- [Reconnect & reconciliation](#reconnect--reconciliation)
- [Security model](#security-model)
- [Remote tests](#remote-tests)

> Two real hosts, a private CA, mutual TLS, firewall and boot-time start are a
> separate runbook: [`deploy.md`](./deploy.md). What follows is the mechanism.

## Start the daemon (machine B)

```bash
export AGENTMESH_DAEMON_TOKEN="$(openssl rand -hex 32)"   # value never goes in config
npx tsx src/cli.ts daemon \
  --config agentmesh.yaml \
  --host 0.0.0.0 --port 8790 \
  --token-env AGENTMESH_DAEMON_TOKEN \
  --tls-cert ./certs/daemon.pem --tls-key ./certs/daemon-key.pem
```

Flags: `--host` `--port` `--token-env` `--tls-cert` `--tls-key` `--tls-ca`
(enables mTLS: the daemon then *requires* a client certificate signed by that CA)
`--allow-insecure` (explicit opt-out of the TLS requirement for non-loopback
binds). The same keys can live under a `daemon:` block in `agentmesh.yaml`.
Certificate, key and CA values may be paths or inline PEM; a path that cannot be
read fails startup with `tls_invalid` rather than an opaque handshake error on
the other side. Two probes are available:

- `GET /healthz` — **unauthenticated** `{ ok, daemonId, protocol }` liveness.
- `GET /profiles` — **authenticated**; lists the profiles the daemon exposes.

## Point a master at it (machine A)

```yaml
profiles:
  - name: big-gpu-impl
    driver: remote
    remote:
      endpoint: https://gpu.example.com:8790   # wss:// derived automatically
      tokenEnv: AGENTMESH_REMOTE_TOKEN          # value read from env, never stored
      remoteProfile: opencode                   # which daemon-side profile to run
      # ca: ./certs/daemon-ca.pem               # trust a self-signed daemon cert
```

Then the master drives it exactly like a local worker — `task_submit { profile:
"big-gpu-impl" }`, `task_wait`, `task_approve` when a remote permission request
arrives. Remote events are streamed back and persisted locally.

## Reconnect & reconciliation

If a connection drops mid-run, the master must not guess the outcome. The daemon
persists every task to its local store, so a client can re-ask for the
authoritative record with a one-shot query — no live turn socket required:

```ts
import { queryRemoteTask } from "agentmesh";

const rec = await queryRemoteTask(
  { endpoint: "https://gpu.example.com:8790", tokenEnv: "AGENTMESH_REMOTE_TOKEN" },
  taskId,
);
// rec is the real TaskRecord, or undefined if the daemon has no such task.
```

Because the daemon cancels orphaned tasks when a socket closes, a task that was
running at drop time reconciles to `cancelled` — never a false `succeeded`.
`RemoteWorkerDriver.queryTask(remote, taskId)` exposes the same call.

For a **still-running** task you'd rather resume than re-run, start the daemon
with an orphan grace window (`orphanGraceMs`) and re-attach: the daemon replays
every persisted event after a sequence boundary, then streams live events to
completion — no re-submission, no duplicated work.

```ts
import { attachRemoteTask } from "agentmesh";

const rec = await attachRemoteTask(
  { endpoint: "https://gpu.example.com:8790", tokenEnv: "AGENTMESH_REMOTE_TOKEN" },
  taskId,
  {
    afterSequence: lastSeq,               // resume where we left off (0 = full replay)
    onEvent: (ev) => render(ev),          // replayed + live events, deduped by sequence
    onPermissionRequest: async (req) => decide(req), // approvals still round-trip
  },
);
// rec is the authoritative terminal TaskRecord.
```

With `orphanGraceMs: 0` (the default) a drop cancels the task immediately and
`queryRemoteTask` reads back `cancelled`; with a grace window the task survives a
brief disconnect and `attachRemoteTask` picks its stream back up. Aborting an
attach detaches without cancelling the remote task.

Resumption can also be **transparent**: set `resume: true` on a remote profile and
`runTurn` itself re-attaches on a mid-run drop (bounded by `reconnectAttempts` /
`reconnectDelayMs`), dedupes replayed events by sequence, and resolves normally —
the master never sees the blip. Pair it with a daemon `orphanGraceMs` window.

```yaml
profiles:
  - name: big-gpu-impl
    driver: remote
    remote:
      endpoint: https://gpu.example.com:8790
      tokenEnv: AGENTMESH_REMOTE_TOKEN
      remoteProfile: opencode
      resume: true              # auto re-attach if the socket drops mid-turn
      reconnectAttempts: 3
      reconnectDelayMs: 500
```

## Security model

- **Token required.** The daemon refuses to start if `tokenEnv` is unset or the
  variable is empty; every upgrade/request is checked with a constant-time
  comparison (`timingSafeEqual`). Tokens are read from the environment — never
  written to config or committed to version control.
- **Zero-downtime key rotation.** `tokenEnv` may name several comma-separated
  environment variables, and each variable may hold several comma-separated
  tokens, so the daemon can accept an old and a new secret at once. Send `SIGHUP`
  (or call `daemon.reloadTokens()`) to re-read them without restarting — add the
  new secret, migrate clients, then drop the old one. Reload refuses an empty set
  so the daemon can never silently become unauthenticated or lock itself out.
- **Workdir whitelist.** `daemon.allowCwd` restricts where a remote task may run;
  a `cwd` outside it (including `../` traversal and sibling-prefix tricks like
  `/srv/repos_evil`) is rejected before any worker starts.
- **TLS for anything non-loopback.** `assertSafeBind` refuses to bind a
  non-loopback host without TLS unless you pass `--allow-insecure`. Loopback
  `http://` is allowed for local dev/tests.
- **Optional mutual TLS.** Setting `daemon.tls.ca` makes the daemon demand a
  client certificate signed by that CA (`requestCert` + `rejectUnauthorized`);
  the handshake fails before any request is parsed, and the refusal is audited as
  `tls_reject` with the peer address. On the master side, `remote.cert` /
  `remote.key` supply the client certificate. This is what makes a stolen bearer
  token insufficient on its own.
- **Rotating audit log.** Size-based rotation (`daemon.auditMaxBytes` /
  `auditKeep`, default 10 MiB × 5) keeps a probing attacker from filling the
  disk; rotated files are closed archives, and records arriving mid-rotation are
  buffered rather than dropped.
- **ACP stdio stays local.** The daemon runs ACP in-process on machine B; only
  typed task events cross the wire. There is no raw stdio passthrough.
- **No orphans.** If the WebSocket drops, the daemon cancels any non-terminal
  task it was running for that connection — unless an `orphanGraceMs` window is
  configured, during which the task stays alive so a client can `attach` and
  resume it. Either way a dropped task is never silently reported as success.
- **Structured audit trail.** Every control-plane decision — auth success/failure
  (with peer address), connection open/close, submit and its whitelist/profile
  verdicts, approvals, cancels, attaches, orphan handling, and credential
  reloads — is appended as NDJSON to `daemon.auditPath` (default
  `<workdir>/daemon-audit.ndjson`). Secrets are never written: a token is reduced
  to a 12-hex non-reversible fingerprint, and untrusted task/agent text is not
  logged at all. Writes are buffered so a flood of bad-token attempts can't block
  the event loop. Set `auditPath: ""` to disable.

> Global guards that apply to every deployment — delegation-depth cap, resource
> limits, and the bounded FIFO scheduler — live in the README under
> [Safety and limits](../README.md#safety-and-limits).

## Remote tests

`test/remote.test.ts` boots an ephemeral loopback daemon against mocks and drives
a real `RemoteWorkerDriver` client through it — dispatch + streamed events,
approval round-trip, cancel, bad-token rejection, cwd-whitelist refusal, the
`/healthz` vs `/profiles` auth split, reconnect reconciliation (completed-task
query, unknown-id → `undefined`, and a dropped mid-run connection reconciling to
`cancelled` not `succeeded`), push-based resumption (`attach` replays a
dropped-but-grace task to success, `afterSequence` replays only newer events,
unknown-task attach rejects, and `runTurn` transparently re-attaches after a
mid-run drop when `resume: true`), zero-downtime key rotation (multiple valid
tokens accepted at once over both HTTP and the WS upgrade, and `reloadTokens()`
rotating live while refusing an empty set), a structured audit trail (records
auth/submit/refusal decisions and asserts no token ever appears in cleartext),
and unit coverage of `assertSafeBind` / `assertCwdAllowed`. 18 remote tests, no
network, no API cost.

`test/deploy.test.ts` covers the deployment path with committed throwaway
certificates (see `test/fixtures/tls/README.md`): a client without a certificate
is refused before a task exists, a certificate from a foreign CA is refused
while the right one is accepted, an untrusted *server* certificate is rejected by
the client, and the audit log rotates by size without losing a retained record.
For a run against a real network interface, use `npm run deploy:tls`
([`deploy.md`](./deploy.md)).
