/**
 * Real TLS deployment check — no loopback shortcut.
 *
 * Every other test binds 127.0.0.1, which cannot prove anything about a
 * two-host deployment: the certificate never gets validated against a real
 * network address and the "refuse plaintext on a reachable interface" guard is
 * never exercised. This script binds the daemon to a *real* interface of this
 * machine and connects to it over that address, so the handshake, the SAN check
 * and the token check all travel the same path they would between two hosts.
 *
 * What it verifies, in order:
 *   1. a plaintext bind on a non-loopback address is refused (insecure_bind)
 *   2. a fresh CA + server cert (SAN = this host's address) is generated
 *   3. a master trusting that CA runs a task over TLS: submit → events → result
 *   4. the audit trail records a TLS start and an authenticated peer
 *   5. a master trusting a DIFFERENT CA is refused (no task admitted)
 *   6. mutual TLS: no client certificate → refused; valid client cert → runs
 *
 * Usage:  npm run deploy:tls [-- --host 192.168.1.20] [--keep]
 */
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { WorkerDaemon } from "../src/remote/daemon.js";
import { FileAuditLog, NoopAuditLog, type AuditLog } from "../src/remote/audit.js";
import { SecurityError } from "../src/remote/security.js";

const TOKEN_ENV = "AGENTMESH_DEPLOY_TOKEN";
process.env[TOKEN_ENV] = `deploy-${Math.random().toString(16).slice(2)}-token`;
const TOKEN = process.env[TOKEN_ENV]!;

const argv = process.argv.slice(2);
const hostFlag = argv.indexOf("--host");
const explicitHost = hostFlag >= 0 ? argv[hostFlag + 1] : undefined;
const keep = argv.includes("--keep");

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}
const results: Result[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}\n`);
}

/** First non-internal IPv4 address, preferring a private LAN range. */
function pickAddress(): string | undefined {
  const addrs: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal) addrs.push(a.address);
    }
  }
  const preferred = addrs.find(
    (a) => a.startsWith("192.168.") || a.startsWith("10.") || /^172\.(1[6-9]|2\d|3[01])\./.test(a),
  );
  return preferred ?? addrs[0];
}

const address = explicitHost ?? pickAddress();
if (!address) {
  console.error("no non-loopback IPv4 address found; pass --host <ip> to choose one");
  process.exit(2);
}

const workRoot = mkdtempSync(path.join(tmpdir(), "agentmesh-deploy-tls-"));
const certDir = path.join(workRoot, "certs");
const runDir = path.join(workRoot, "run");

const config = parseConfig({
  workdir: path.join(workRoot, "state"),
  profiles: [{ name: "worker", driver: "mock", mock: { delayMs: 5, toolCalls: 2 } }],
});

function masterConfig(endpoint: string, tls: { ca?: string; cert?: string; key?: string }) {
  return parseConfig({
    profiles: [
      {
        name: "r-worker",
        driver: "remote",
        remote: { endpoint, tokenEnv: TOKEN_ENV, remoteProfile: "worker", connectTimeoutMs: 10000, ...tls },
      },
    ],
  });
}

interface RunOptions {
  /** daemon TLS material; omit for plaintext */
  daemonTls?: { cert: string; key: string; ca?: string };
  /** master trust material */
  clientTls: { ca?: string; cert?: string; key?: string };
  audit?: boolean;
}

interface RunOutcome {
  status: string;
  error?: string;
  tasks: number;
  url: string;
}

/** Start a daemon on this machine's real interface, run one task, tear down. */
async function runTask(label: string, opts: RunOptions): Promise<RunOutcome> {
  const dOrch = new Orchestrator(config, { baseCwd: runDir, persist: false });
  const auditPath = path.join(workRoot, `audit-${label}.ndjson`);
  const audit: AuditLog = opts.audit
    ? new FileAuditLog(auditPath, `daemon-${label}`)
    : new NoopAuditLog();
  const daemon = new WorkerDaemon({
    config,
    orchestrator: dOrch,
    host: "0.0.0.0", // every interface: exactly what a worker host does
    port: 0,
    token: TOKEN,
    allowCwd: [runDir],
    tls: opts.daemonTls,
    audit,
  });
  const started = await daemon.start();
  const url = started.url.replace("0.0.0.0", address!);

  const mOrch = new Orchestrator(masterConfig(url, opts.clientTls), {
    baseCwd: runDir,
    persist: false,
  });
  try {
    const events: string[] = [];
    const res = await mOrch.dispatch({
      profile: "r-worker",
      task: `deployment check ${label}`,
      onEvent: (ev) => {
        if (ev.type === "output" && ev.data?.kind) events.push(String(ev.data.kind));
      },
    });
    const outcome: RunOutcome = {
      status: res.status,
      error: res.error?.message,
      tasks: dOrch.listTasks().length,
      url,
    };
    return outcome;
  } finally {
    await mOrch.shutdown().catch(() => {});
    await daemon.stop().catch(() => {});
    await dOrch.shutdown().catch(() => {});
    // `daemon.stop()` flushes and closes the audit stream, so the file is safe
    // to read once this function returns.
  }
}

async function main(): Promise<void> {
  process.stdout.write(`host address : ${address}\n`);
  process.stdout.write(`work dir     : ${workRoot}\n\n`);

  /* 1 — the guard that makes a cross-host bind safe in the first place ------ */
  {
    const orch = new Orchestrator(config, { baseCwd: runDir, persist: false });
    let code = "";
    try {
      new WorkerDaemon({ config, orchestrator: orch, host: "0.0.0.0", token: TOKEN });
    } catch (e) {
      code = e instanceof SecurityError ? e.code : "other";
    }
    await orch.shutdown().catch(() => {});
    check("plaintext bind on a reachable interface is refused", code === "insecure_bind", code);
  }

  /* 2 — fresh certificates for THIS address -------------------------------- */
  try {
    execFileSync(
      "bash",
      [
        path.join("deploy", "certs", "make-certs.sh"),
        "--out",
        certDir,
        "--san",
        `DNS:${os.hostname()},IP:${address},IP:127.0.0.1`,
        "--prefix",
        "agentmesh-deploy",
      ],
      { stdio: "pipe" },
    );
    const pem = readFileSync(path.join(certDir, "server.pem"), "utf8");
    check("generated a CA and a server certificate for this address", pem.includes("BEGIN CERTIFICATE"), certDir);
  } catch (e) {
    check("generated a CA and a server certificate for this address", false, (e as Error).message);
    process.exitCode = 1;
    return;
  }

  const serverTls = { cert: path.join(certDir, "server.pem"), key: path.join(certDir, "server-key.pem") };
  const ca = path.join(certDir, "ca.pem");
  const clientTls = {
    cert: path.join(certDir, "client.pem"),
    key: path.join(certDir, "client-key.pem"),
  };

  /* 3 + 4 — a real task over TLS, then read the audit trail ---------------- */
  {
    const out = await runTask("tls", { daemonTls: serverTls, clientTls: { ca }, audit: true });
    check(
      "task completes over TLS to a real interface",
      out.status === "completed",
      `${out.status}${out.error ? `: ${out.error}` : ""} @ ${out.url}`,
    );
    const auditPath = path.join(workRoot, "audit-tls.ndjson");
    const audit = readFileSync(auditPath, "utf8");
    const start = audit.split("\n").find((l) => l.includes('"daemon_start"')) ?? "";
    check("audit records a TLS listener", /"tls":true/.test(start), start.trim().slice(0, 120));
    const authPeers = audit
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as { event?: string; peer?: string };
        } catch {
          return {};
        }
      })
      .filter((r) => r.event === "auth_ok")
      .map((r) => r.peer ?? "");
    check("audit records an authenticated remote peer", authPeers.length > 0);
    // The peer address is the address we dialed, not 127.0.0.1 — proof the
    // traffic really arrived on this machine's network interface.
    check(
      "the daemon saw the connection on the real interface",
      authPeers.some((p) => p.includes(address!)),
      authPeers.join(","),
    );
  }

  /* 5 — a master that trusts the wrong CA ---------------------------------- */
  {
    // The "untrusted" fixture CA has no relation to this server certificate.
    const rogue = path.resolve("test/fixtures/tls/untrusted/ca.pem");
    const out = await runTask("wrong-ca", { daemonTls: serverTls, clientTls: { ca: rogue } });
    check(
      "a master trusting the wrong CA is refused",
      out.status === "failed" && out.tasks === 0,
      `${out.status}${out.error ? `: ${out.error.split("\n")[0]}` : ""}`,
    );
  }

  /* 6 — mutual TLS -------------------------------------------------------- */
  {
    const mtlsDaemon = { ...serverTls, ca };
    const noCert = await runTask("mtls-missing", { daemonTls: mtlsDaemon, clientTls: { ca } });
    check(
      "mTLS: a client without a certificate is refused before any task is admitted",
      noCert.status === "failed" && noCert.tasks === 0,
      `${noCert.status}${noCert.error ? `: ${noCert.error.split("\n")[0]}` : ""}`,
    );
    const withCert = await runTask("mtls-ok", { daemonTls: mtlsDaemon, clientTls: { ca, ...clientTls } });
    check(
      "mTLS: a client with a CA-signed certificate runs the task",
      withCert.status === "completed",
      `${withCert.status}${withCert.error ? `: ${withCert.error}` : ""}`,
    );
  }
}

try {
  await main();
} finally {
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} checks passed` +
      (failed.length ? ` — ${failed.map((f) => f.name).join("; ")}` : ""),
  );
  process.stdout.write(`\nTLS DEPLOY: ${failed.length === 0 ? "PASS" : "FAIL"}\n`);
  if (keep) {
    process.stdout.write(`certificates kept in ${certDir}\n`);
  } else {
    rmSync(workRoot, { recursive: true, force: true });
  }
  if (failed.length > 0) process.exitCode = 1;
}
