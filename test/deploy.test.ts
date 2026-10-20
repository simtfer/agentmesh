/**
 * Deployment-path tests: the parts that only matter once the daemon leaves
 * loopback — a real certificate chain, optional mutual TLS, and an audit log
 * that rotates instead of growing without bound.
 *
 * The certificates under `test/fixtures/tls` are throwaway fixtures (see their
 * README) so this file stays hermetic: no openssl, no network, no API cost.
 * Actual cross-host runs are scripted in `scripts/remote-tls-deploy.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { WorkerDaemon } from "../src/remote/daemon.js";
import { FileAuditLog, openAuditLog, NoopAuditLog } from "../src/remote/audit.js";
import { readPem, SecurityError } from "../src/remote/security.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures", "tls");
const trusted = (f: string) => path.join(FIX, "trusted", f);
const untrusted = (f: string) => path.join(FIX, "untrusted", f);

const TOKEN_ENV = "AGENTMESH_DEPLOY_TOKEN";
const TOKEN = "deploy-test-token";
process.env[TOKEN_ENV] = TOKEN;

// Some sandboxes and dev containers export NODE_TLS_REJECT_UNAUTHORIZED=0,
// which switches certificate verification off process-wide. These tests exist to
// prove that a wrong CA *is* refused, so verification is restored here — leaving
// it off would let them pass for the opposite reason (and hide a real regression).
// `process.env` is re-read at connect time, so deleting it is enough.
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

const daemonConfig = parseConfig({
  // Keep state out of the repo: the suite must not leave directories behind.
  workdir: path.join(tmpdir(), "agentmesh-deploy-state"),
  profiles: [{ name: "worker", driver: "mock", mock: { delayMs: 2, toolCalls: 1 } }],
});

interface Harness {
  url: string;
  dir: string;
  daemon: WorkerDaemon;
  orch: Orchestrator;
  stop: () => Promise<void>;
}

async function startDaemon(opts: {
  tls: { cert?: string; key?: string; ca?: string };
  auditPath?: string;
  auditMaxBytes?: number;
  allowCwd: string[];
}): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-deploy-"));
  const orch = new Orchestrator(daemonConfig, { baseCwd: dir, persist: false });
  const daemon = new WorkerDaemon({
    config: daemonConfig,
    orchestrator: orch,
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    allowCwd: opts.allowCwd,
    tls: opts.tls,
    audit: opts.auditPath
      ? new FileAuditLog(opts.auditPath, "daemon-deploy-test", {
          maxBytes: opts.auditMaxBytes,
        })
      : new NoopAuditLog(),
  });
  const info = await daemon.start();
  return {
    url: info.url,
    dir,
    daemon,
    orch,
    stop: async () => {
      await daemon.stop().catch(() => {});
      await orch.shutdown().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function masterOrch(
  url: string,
  baseCwd: string,
  remote: { ca?: string; cert?: string; key?: string },
): Orchestrator {
  const cfg = parseConfig({
    profiles: [
      {
        name: "r-worker",
        driver: "remote",
        // A remote profile names a path on the *daemon's* host and the master
        // sends it verbatim; without one the daemon falls back to its own
        // default, which is not in `allowCwd` here.
        cwd: baseCwd,
        remote: { endpoint: url, tokenEnv: TOKEN_ENV, remoteProfile: "worker", ...remote },
      },
    ],
  });
  return new Orchestrator(cfg, { baseCwd, persist: false });
}

/* ------------------------------ TLS material ---------------------------- */

test("readPem accepts inline PEM, reads a path, and refuses a bad path loudly", () => {
  const inline = readFileSync(trusted("ca.pem"), "utf8");
  assert.equal(readPem(inline, "ca"), inline, "inline PEM passes through untouched");
  assert.equal(readPem(trusted("ca.pem"), "ca"), inline, "a path is read from disk");
  assert.equal(readPem(undefined, "ca"), undefined);
  assert.equal(readPem("", "ca"), undefined);

  // A typo in a config path must fail where the operator can see it, not as an
  // opaque handshake error on the other machine.
  assert.throws(
    () => readPem(path.join(FIX, "nope.pem"), "remote.ca"),
    (e: unknown) => e instanceof SecurityError && e.code === "tls_invalid",
  );

  const notPem = path.join(mkdtempSync(path.join(tmpdir(), "agentmesh-pem-")), "notes.txt");
  writeFileSync(notPem, "this is not a certificate\n");
  assert.throws(
    () => readPem(notPem, "remote.ca"),
    (e: unknown) => e instanceof SecurityError && e.code === "tls_invalid",
  );
  rmSync(path.dirname(notPem), { recursive: true, force: true });
});

/* --------------------------------- mTLS --------------------------------- */

test("mTLS: a client without a certificate is refused before any task exists", async () => {
  const auditDir = mkdtempSync(path.join(tmpdir(), "agentmesh-mtls-audit-"));
  const auditPath = path.join(auditDir, "audit.ndjson");
  const harness = await startDaemon({
    tls: {
      cert: trusted("server.pem"),
      key: trusted("server-key.pem"),
      ca: trusted("ca.pem"), // configuring a CA is what enables mTLS
    },
    auditPath,
    allowCwd: [auditDir],
  });
  const bare = masterOrch(harness.url, auditDir, { ca: trusted("ca.pem") });
  try {
    // dispatch() resolves with a failed turn rather than throwing: the TLS
    // handshake is refused before any HTTP request, so the failure surfaces as
    // a connection error, not as an application-level rejection.
    const res = await bare.dispatch({ profile: "r-worker", task: "should never run" });
    assert.equal(res.status, "failed", "a client with no certificate must not reach the daemon");
    assert.match(
      res.error?.message ?? "",
      /certificate required|alert certificate|handshake|ECONNRESET/i,
      `unexpected failure: ${res.error?.message}`,
    );
    // Nothing ran: TLS refused the connection before the submit handler.
    assert.equal(harness.orch.listTasks().length, 0, "no task may be admitted without a client cert");

    // The handshake failure is audited — otherwise an operator sees a client
    // that "cannot connect" with no server-side trace.
    const audit = new FileAuditLog(auditPath, "daemon-deploy-test");
    await audit.close();
    const text = readFileSync(auditPath, "utf8");
    assert.match(text, /"event":"tls_reject"/, "TLS refusals must be audited");
  } finally {
    await bare.shutdown().catch(() => {});
    await harness.stop();
    rmSync(auditDir, { recursive: true, force: true });
  }
});

test("mTLS: a certificate from another CA is refused, the right one is accepted", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-mtls-ok-"));
  const harness = await startDaemon({
    tls: {
      cert: trusted("server.pem"),
      key: trusted("server-key.pem"),
      ca: trusted("ca.pem"),
    },
    allowCwd: [dir],
  });
  // Signed by the rogue CA: the chain does not reach the daemon's CA.
  const wrong = masterOrch(harness.url, dir, {
    ca: trusted("ca.pem"),
    cert: untrusted("server.pem"),
    key: untrusted("server-key.pem"),
  });
  const right = masterOrch(harness.url, dir, {
    ca: trusted("ca.pem"),
    cert: trusted("client.pem"),
    key: trusted("client-key.pem"),
  });
  try {
    const denied = await wrong.dispatch({ profile: "r-worker", task: "wrong client cert" });
    assert.equal(denied.status, "failed", "a client cert from another CA must be refused");
    const res = await right.dispatch({ profile: "r-worker", task: "mutual tls run" });
    assert.equal(res.status, "completed", `expected success, got ${res.status}: ${res.error?.message}`);
  } finally {
    await wrong.shutdown().catch(() => {});
    await right.shutdown().catch(() => {});
    await harness.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a server certificate from an untrusted CA is rejected by the client", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-rogue-"));
  const harness = await startDaemon({
    tls: { cert: untrusted("server.pem"), key: untrusted("server-key.pem") },
    allowCwd: [dir],
  });
  const orch = masterOrch(harness.url, dir, { ca: trusted("ca.pem") });
  try {
    const res = await orch.dispatch({ profile: "r-worker", task: "trust me" });
    assert.equal(res.status, "failed", "a certificate from an untrusted CA must be refused");
    const msg = `${res.error?.message ?? ""} ${res.error?.code ?? ""}`;
    assert.match(msg, /certificate|verify|self-signed|SELF_SIGNED|UNABLE_TO_VERIFY/i);
    assert.equal(harness.orch.listTasks().length, 0);
  } finally {
    await orch.shutdown().catch(() => {});
    await harness.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plaintext is refused on a non-loopback bind even with a token configured", () => {
  assert.throws(
    () =>
      new WorkerDaemon({
        config: daemonConfig,
        orchestrator: new Orchestrator(daemonConfig, { baseCwd: tmpdir(), persist: false }),
        host: "0.0.0.0",
        token: TOKEN,
      }),
    (e: unknown) => e instanceof SecurityError && e.code === "insecure_bind",
  );
});

/* ---------------------------- audit rotation ---------------------------- */

test("the audit log rotates by size, keeps its bound, and loses no retained record", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-rotate-"));
  const file = path.join(dir, "audit.ndjson");
  const log = new FileAuditLog(file, "rotate-test", { maxBytes: 2000, keep: 3 });
  const total = 240;
  for (let i = 0; i < total; i++) {
    log.record("submit_ok", { seq: i, pad: "x".repeat(80) });
  }
  await log.close();

  assert.ok(existsSync(file), "live file exists");
  assert.ok(existsSync(`${file}.1`), "at least one archive was produced");
  assert.ok(!existsSync(`${file}.4`), "keep=3 must not leave a fourth archive");

  // Retained archives + live file must tile a contiguous run of sequence
  // numbers: rotation drops the oldest data, never a record in the middle.
  const seqs: number[] = [];
  for (const f of [file, `${file}.1`, `${file}.2`, `${file}.3`]) {
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
    assert.ok(lines.length > 0, `${path.basename(f)} should not be empty`);
    for (const line of lines) {
      const rec = JSON.parse(line) as { seq?: number; event?: string };
      assert.equal(rec.event, "submit_ok");
      seqs.push(rec.seq!);
    }
  }
  seqs.sort((a, b) => a - b);
  assert.deepEqual(
    seqs,
    Array.from({ length: seqs.length }, (_, i) => seqs[0]! + i),
    "retained records must be contiguous and unsorted-free (no gaps, no losses)",
  );
  // The newest record is never rotated away.
  assert.equal(seqs.at(-1), total - 1);

  rmSync(dir, { recursive: true, force: true });
});

test("rotation can be disabled with maxBytes: 0, and empty auditPath disables auditing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-norotate-"));
  const file = path.join(dir, "audit.ndjson");
  const log = new FileAuditLog(file, "norotate", { maxBytes: 0, keep: 3 });
  for (let i = 0; i < 50; i++) log.record("submit_ok", { i, pad: "y".repeat(200) });
  await log.close();
  assert.ok(!existsSync(`${file}.1`), "maxBytes: 0 must never rotate");
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 50);

  assert.equal(openAuditLog("x", "", "/tmp/ignored").constructor.name, "NoopAuditLog");
  rmSync(dir, { recursive: true, force: true });
});

test("daemon settings accept audit rotation knobs and the daemon applies them", async () => {
  const cfg = parseConfig({
    workdir: ".w",
    profiles: [{ name: "w", driver: "mock" }],
    daemon: { auditMaxBytes: 512, auditKeep: 2 },
  });
  assert.equal(cfg.daemon?.auditMaxBytes, 512);
  assert.equal(cfg.daemon?.auditKeep, 2);
});
