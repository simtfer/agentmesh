# Deploying across two hosts (TLS)

[`remote.md`](./remote.md) describes *what* the Worker Daemon does. This page is
the operator's runbook: two real machines, a private CA, mutual TLS, a firewall,
boot-time start and log rotation — the difference between "it works on loopback"
and "it is running on the build box".

For the configuration of both hosts key by key (including the `cwd` contract and
a verification ladder), see [`two-host.md`](./two-host.md); for the short path,
[`quickstart.md`](./quickstart.md).

```
 machine A — master                              machine B — worker
┌──────────────────────────────┐                ┌───────────────────────────────┐
│ orchestrator + MCP server    │  WSS :8790     │ agentmesh daemon              │
│ profile: driver: remote      │ ─────────────▶ │  TLS (+ mTLS) + bearer token  │
│ token from env               │ ◀───────────── │  local ACP agents (opencode…) │
│ no inbound port needed       │  task events   │  needs inbound 8790 only      │
└──────────────────────────────┘                └───────────────────────────────┘
```

## What is verified, and what is not

`npm run deploy:tls` runs the whole stack over a **real network interface** of
one machine (its LAN address, not `127.0.0.1`): it generates a CA, binds the
daemon on `0.0.0.0` with TLS, connects a master that trusts that CA, runs a task,
and then checks the failure modes — a master trusting the wrong CA, a plaintext
bind on a reachable interface, and mutual TLS with a missing or foreign client
certificate. It asserts the daemon observed the connection on that address, so
the traffic is not taking a loopback shortcut.

What it cannot cover is the distance between two physical machines: DNS,
routing, and the worker's firewall. Those are the steps below, and they are the
ones that usually fail first. Treat the script as "the software is correct" and
the checklist as "the deployment is correct".

## 1. Worker host (machine B)

```bash
# code + build
git clone https://github.com/simtfer/agentmesh.git /srv/agentmesh
cd /srv/agentmesh && npm ci && npm run build

# a service account that owns the workdirs the daemon may use
sudo useradd --system --create-home --home-dir /var/lib/agentmesh agentmesh
sudo mkdir -p /srv/repos && sudo chown agentmesh: /srv/repos
```

Generate the certificates **on the CA** (which may be machine B itself for a
single deployment). The SAN must contain the name or address masters actually
dial — a certificate for `worker.internal` is useless if clients connect to
`10.0.0.12`:

```bash
bash deploy/certs/make-certs.sh \
  --out /etc/agentmesh/certs \
  --san "DNS:worker.internal,IP:10.0.0.12"
sudo chown -R agentmesh: /etc/agentmesh/certs
sudo chmod 600 /etc/agentmesh/certs/*-key.pem
```

Config — secrets are named, never inlined:

```yaml
# /etc/agentmesh/agentmesh.yaml
workdir: /var/lib/agentmesh

profiles:
  - name: opencode
    driver: acpx
    agent: opencode
    cwd: /srv/repos

daemon:
  host: 0.0.0.0
  port: 8790
  tokenEnv: AGENTMESH_DAEMON_TOKEN     # value lives in the environment
  allowCwd: [/srv/repos]               # nothing outside these roots may run
  tls:
    cert: /etc/agentmesh/certs/server.pem
    key:  /etc/agentmesh/certs/server-key.pem
    ca:   /etc/agentmesh/certs/ca.pem  # presence ⇒ mutual TLS is required
  auditPath: /var/lib/agentmesh/daemon-audit.ndjson
  auditMaxBytes: 10485760              # rotate at 10 MiB
  auditKeep: 5                         # keep five archives
  orphanGraceMs: 30000                 # allow a reconnect to resume a running task
```

```bash
sudo install -d -m 700 /etc/agentmesh
printf 'AGENTMESH_DAEMON_TOKEN=%s\n' "$(openssl rand -hex 32)" \
  | sudo tee /etc/agentmesh/worker.env >/dev/null
sudo chmod 600 /etc/agentmesh/worker.env
```

Smoke-test before wiring it to boot:

```bash
sudo -u agentmesh env $(sudo cat /etc/agentmesh/worker.env) \
  node /srv/agentmesh/dist/cli.js daemon --config /etc/agentmesh/agentmesh.yaml
# in another shell, from machine A or B:
curl -k https://worker.internal:8790/healthz          # {"ok":true,...} — no auth
```

`/healthz` is unauthenticated by design (it is a liveness probe and returns no
data). Everything else needs the bearer token.

## 2. Master host (machine A)

```bash
export AGENTMESH_REMOTE_TOKEN='<the same 32-byte hex secret>'
```

```yaml
# agentmesh.yaml on the master
profiles:
  - name: worker-opencode
    driver: remote
    remote:
      endpoint: https://worker.internal:8790
      tokenEnv: AGENTMESH_REMOTE_TOKEN
      remoteProfile: opencode
      ca: /etc/agentmesh/ca.pem          # trust the private CA
      cert: /etc/agentmesh/client.pem    # required when the daemon runs mTLS
      key: /etc/agentmesh/client-key.pem
      resume: true                       # re-attach if the socket drops mid-run
      reconnectAttempts: 3
```

The master opens **no** inbound port: it dials out and streams results back.

```bash
node dist/cli.js run --profile worker-opencode --task "summarise the repo"
```

## 3. Firewall

Only one direction is needed: master → worker, TCP 8790. Pin the source to the
master's address; the token plus mTLS is defence in depth, not a substitute.

```bash
# ufw
sudo ufw allow from 10.0.0.5 to any port 8790 proto tcp
# firewalld
sudo firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=10.0.0.5 port port=8790 protocol=tcp accept'
sudo firewall-cmd --reload
```

```powershell
# Windows worker host
New-NetFirewallRule -DisplayName "agentmesh worker 8790" -Direction Inbound `
  -Protocol TCP -LocalPort 8790 -RemoteAddress 10.0.0.5 -Action Allow
```

Never expose 8790 to the internet: the daemon runs coding agents that execute
tools on the host, so an authenticated caller is equivalent to shell access.

## 4. Start at boot

Linux — the unit in this repo assumes `/srv/agentmesh` and the `agentmesh` user:

```bash
sudo cp deploy/systemd/agentmesh-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agentmesh-worker
systemctl status agentmesh-worker
```

`SIGTERM` shuts down cleanly (the daemon cancels nothing on the way out, but it
does flush and close the audit stream). `systemctl reload agentmesh-worker`
sends `SIGHUP`, which re-reads the token set — see rotation below.

Windows — register the wrapper as a boot task (no extra software):

```bat
setx /M AGENTMESH_DAEMON_TOKEN "<openssl rand -hex 32>"
schtasks /create /tn "agentmesh worker" /tr "C:\agentmesh\deploy\windows\run-worker.cmd" ^
         /sc onstart /ru SYSTEM /rl HIGHEST /f
```

Use NSSM or WinSW instead if you already have them; they rotate the stdout log,
which the plain redirect in `run-worker.cmd` does not.

## 5. Logs

Two different logs, rotated differently:

| log | where | rotation |
| --- | --- | --- |
| **audit trail** (NDJSON, security-relevant: auth, submits, approvals, cancels, TLS refusals) | `daemon.auditPath` | size-based, in-process: `auditMaxBytes` / `auditKeep` |
| **stdout/stderr** (startup errors, shutdown notices) | journald, or `daemon.out.log` on Windows | journald/systemd, or the operator |

Rotation renames the live file to `.1`, shifts `.1` → `.2`, and drops the oldest
once `auditKeep` is reached. Rotated files are always closed archives, so a
reader never sees a half-written record. Records that arrive mid-rotation are
buffered, not lost. Set `auditMaxBytes: 0` to disable rotation and hand the file
to an external collector — but never leave it unbounded: a token-probing attacker
can write new lines faster than disk reclaims them.

## 6. Certificates and secrets

**Two independent rotations, different mechanisms:**

```text
token  (bearer)   no restart   add the new secret next to the old in the SAME env
                               var (comma-separated), reload (SIGHUP), migrate
                               clients, then remove the old one and reload again

cert   (TLS)      restart      ship the new cert/key, restart the daemon; the
                               window is a few hundred ms and only affects new
                               connections
```

Token rotation is zero-downtime because `tokenEnv` accepts several names and each
name may hold several comma-separated values. The daemon refuses to rotate to an
empty set, so a typo cannot silently make it unauthenticated — or lock you out.

Certificate rotation is a restart. Plan it for a quiet moment: in-flight turns are
not cancelled on shutdown, but a dropping socket cancels its task unless
`orphanGraceMs` is set and the master re-attaches with `resume: true`.

**Validity.** `make-certs.sh` defaults to 825 days. Renew before expiry —
`openssl x509 -in server.pem -noout -enddate`. A master that connects to an
expired certificate fails with `CERT_HAS_EXPIRED`, which is loud and safe.

**Mutual TLS is opt-in per deployment:** it is on exactly when `daemon.tls.ca` is
set. Keep `ca` for a network you do not fully trust (colleagues' checkouts, a
shared VLAN) and omit it when the bearer token already lives in a secret manager.

## 7. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `SELF_SIGNED_CERT_IN_CHAIN` | master trusts a different CA than the one that signed the daemon's cert | point `remote.ca` at the daemon's CA, not the OS store |
| `ERR_TLS_CERT_ALTNAME_INVALID` | SAN does not contain the name/address in `remote.endpoint` | regenerate with `--san "DNS:…,IP:…"` covering what clients dial |
| `alert certificate required` | daemon runs mTLS, master sent no client certificate | set `remote.cert` / `remote.key` |
| `ECONNRESET` right after connecting | client certificate rejected (wrong CA, wrong EKU) | sign the client cert with `daemon.tls.ca`; check the audit trail for `tls_reject` |
| `401 Unauthorized` on upgrade | token mismatch | same secret on both sides; check the env var is readable by the service account |
| `insecure_bind` at startup | non-loopback bind without `daemon.tls` | configure cert/key, or `--allow-insecure` on an isolated network only |
| `cwd_not_whitelisted` | `cwd` outside `daemon.allowCwd` | widen the whitelist deliberately — this is the guard that stops a remote master running agents in your home directory |
| `tls_invalid` at startup or on connect | cert/key/ca path unreadable, or the file is not PEM | check the path and permissions of the service account |
| task reconciles to `cancelled` after a drop | socket dropped without `orphanGraceMs` | set a grace window and `resume: true` on the master |

The audit trail is the first place to look for "who tried what": every refusal
records the peer address and, for auth failures, a 12-hex fingerprint of the
presented token — never the token itself.

## Not covered

- **HA / multi-master.** One daemon, one store, one SQLite file. Two masters can
  connect, but `daemon.allowCwd` and the scheduler are shared, not partitioned.
- **Rate limiting / quotas.** The bearer token is all-or-nothing; put the daemon
  behind a network policy that limits who can reach the port at all.
- **OS-level sandboxing of the agents.** `ProtectSystem`/`ReadWritePaths` in the
  unit file confine the daemon process, but an agent it spawns inherits that
  confinement — it does not get a per-task sandbox.
