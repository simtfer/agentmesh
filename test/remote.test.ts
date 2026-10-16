/**
 * Remote Worker Daemon end-to-end tests. Everything runs on loopback with mock
 * profiles — no real agents, no cost. Verifies the full proxy path: submit →
 * event stream → approval round-trip → cancel → result, plus the security guards
 * (token auth, workdir whitelist, insecure-bind refusal).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { WorkerDaemon } from "../src/remote/daemon.js";
import { assertCwdAllowed, assertSafeBind, SecurityError } from "../src/remote/security.js";

const TOKEN_ENV = "AGENTMESH_TEST_TOKEN";
const TOKEN = "s3cret-test-token";
process.env[TOKEN_ENV] = TOKEN;

const daemonConfig = parseConfig({
  workdir: ".agentmesh-daemon",
  profiles: [
    { name: "fast", driver: "mock", mock: { delayMs: 2, toolCalls: 2 } },
    { name: "approver", driver: "mock", mock: { delayMs: 2, requireApproval: true } },
    { name: "slow", driver: "mock", mock: { delayMs: 40, toolCalls: 80 } },
  ],
});

interface Harness {
  url: string;
  dir: string;
  daemon: WorkerDaemon;
  dOrch: Orchestrator;
  stop: () => Promise<void>;
}

async function startDaemon(allowCwd: string[]): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-remote-"));
  const dOrch = new Orchestrator(daemonConfig, { baseCwd: dir, persist: false });
  const daemon = new WorkerDaemon({
    config: daemonConfig,
    orchestrator: dOrch,
    host: "127.0.0.1",
    port: 0, // ephemeral
    token: TOKEN,
    allowCwd,
  });
  const info = await daemon.start();
  return {
    url: info.url,
    dir,
    daemon,
    dOrch,
    stop: async () => {
      await daemon.stop().catch(() => {});
      await dOrch.shutdown().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function clientOrch(url: string, baseCwd: string, tokenEnv = TOKEN_ENV) {
  const cfg = parseConfig({
    profiles: [
      { name: "r-fast", driver: "remote", remote: { endpoint: url, tokenEnv, remoteProfile: "fast" } },
      { name: "r-approver", driver: "remote", remote: { endpoint: url, tokenEnv, remoteProfile: "approver" } },
      { name: "r-slow", driver: "remote", remote: { endpoint: url, tokenEnv, remoteProfile: "slow" } },
    ],
  });
  return new Orchestrator(cfg, { baseCwd, persist: false });
}

test("remote dispatch completes and streams events back", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-shared-"));
  const harness = await startDaemon([dir]);
  const orch = clientOrch(harness.url, dir);
  try {
    const seen: string[] = [];
    const res = await orch.dispatch({
      profile: "r-fast",
      task: "analyze the remote module",
      onEvent: (ev) => { if (ev.type === "output") seen.push(String(ev.data?.kind)); },
    });
    assert.equal(res.status, "completed");
    assert.match(res.text, /fast/);
    assert.ok(seen.includes("tool"), `expected tool events, got ${seen.join(",")}`);
    assert.ok(seen.includes("text"));
  } finally {
    await orch.shutdown();
    await harness.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remote approval round-trip: waiting → approve → succeeded", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-shared-"));
  const harness = await startDaemon([dir]);
  const orch = clientOrch(harness.url, dir);
  try {
    const sub = orch.submitTask({ profile: "r-approver", prompt: "risky remote refactor" });
    const rec = await orch.waitTask(sub.taskId, 5000);
    assert.equal(rec?.status, "waiting");

    const pending = orch.pendingApprovals(sub.taskId);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.kind, "permission");
    orch.approveTask(pending[0]!.id, "allow_once");

    const fin = await orch.waitTask(sub.taskId, 5000);
    assert.equal(fin?.status, "succeeded");
  } finally {
    await orch.shutdown();
    await harness.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remote cancel drives the task to cancelled", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-shared-"));
  const harness = await startDaemon([dir]);
  const orch = clientOrch(harness.url, dir);
  try {
    const sub = orch.submitTask({ profile: "r-slow", prompt: "long remote work", timeoutMs: 30000 });
    await new Promise((r) => setTimeout(r, 150));
    const rec = await orch.cancelTask(sub.taskId);
    assert.equal(rec?.status, "cancelled");
  } finally {
    await orch.shutdown();
    await harness.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bad token is rejected at the WebSocket upgrade", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-shared-"));
  const harness = await startDaemon([dir]);
  process.env.AGENTMESH_BAD_TOKEN = "wrong-token";
  const orch = clientOrch(harness.url, dir, "AGENTMESH_BAD_TOKEN");
  try {
    const res = await orch.dispatch({ profile: "r-fast", task: "should not run" });
    assert.equal(res.status, "failed");
  } finally {
    await orch.shutdown();
    await harness.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon refuses a working directory outside the whitelist", async () => {
  const allowed = mkdtempSync(path.join(tmpdir(), "agentmesh-allowed-"));
  const outside = mkdtempSync(path.join(tmpdir(), "agentmesh-outside-"));
  const harness = await startDaemon([allowed]);
  const orch = clientOrch(harness.url, outside); // client cwd NOT whitelisted
  try {
    const res = await orch.dispatch({ profile: "r-fast", task: "escape attempt" });
    assert.equal(res.status, "failed");
    assert.match(res.error?.message ?? "", /whitelist/i);
  } finally {
    await orch.shutdown();
    await harness.stop();
    rmSync(allowed, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("/healthz is reachable without a token", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-shared-"));
  const harness = await startDaemon([dir]);
  try {
    const r = await fetch(`${harness.url}/healthz`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { ok: boolean };
    assert.equal(body.ok, true);
    // profiles endpoint requires auth
    const unauth = await fetch(`${harness.url}/profiles`);
    assert.equal(unauth.status, 401);
    const auth = await fetch(`${harness.url}/profiles`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(auth.status, 200);
  } finally {
    await harness.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------- security unit guards ------------------------- */

test("assertSafeBind refuses non-loopback without TLS", () => {
  assert.throws(() => assertSafeBind("0.0.0.0", false, false), SecurityError);
  assert.doesNotThrow(() => assertSafeBind("0.0.0.0", true, false)); // TLS ok
  assert.doesNotThrow(() => assertSafeBind("127.0.0.1", false, false)); // loopback ok
  assert.doesNotThrow(() => assertSafeBind("0.0.0.0", false, true)); // explicit opt-in
});

test("assertCwdAllowed confines to whitelisted roots by segment", () => {
  const root = path.resolve("/data/projects");
  assert.equal(assertCwdAllowed("/data/projects/app", [root]), path.resolve("/data/projects/app"));
  assert.equal(assertCwdAllowed(root, [root]), root);
  // sibling prefix must NOT match
  assert.throws(() => assertCwdAllowed("/data/projects_evil", [root]), SecurityError);
  // traversal must NOT escape
  assert.throws(() => assertCwdAllowed("/data/projects/../secrets", [root]), SecurityError);
  // empty whitelist rejects everything
  assert.throws(() => assertCwdAllowed("/data/projects/app", []), SecurityError);
});
