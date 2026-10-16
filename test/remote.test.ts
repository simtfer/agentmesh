/**
 * Remote Worker Daemon end-to-end tests. Everything runs on loopback with mock
 * profiles — no real agents, no cost. Verifies the full proxy path: submit →
 * event stream → approval round-trip → cancel → result, plus the security guards
 * (token auth, workdir whitelist, insecure-bind refusal).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket as WS } from "ws";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { WorkerDaemon } from "../src/remote/daemon.js";
import { queryRemoteTask, attachRemoteTask } from "../src/remote/client.js";
import { assertCwdAllowed, assertSafeBind, SecurityError } from "../src/remote/security.js";
import type { RemoteSettings, TaskRecord } from "../src/types.js";
import { TERMINAL_TASK_STATUSES } from "../src/types.js";

const TOKEN_ENV = "AGENTMESH_TEST_TOKEN";
const TOKEN = "s3cret-test-token";
process.env[TOKEN_ENV] = TOKEN;

const daemonConfig = parseConfig({
  workdir: ".agentmesh-daemon",
  profiles: [
    { name: "fast", driver: "mock", mock: { delayMs: 2, toolCalls: 2 } },
    { name: "approver", driver: "mock", mock: { delayMs: 2, requireApproval: true } },
    { name: "slow", driver: "mock", mock: { delayMs: 40, toolCalls: 80 } },
    // ~1.2s run: long enough to drop mid-flight and re-attach within grace.
    { name: "resumable", driver: "mock", mock: { delayMs: 20, toolCalls: 60 } },
  ],
});

interface Harness {
  url: string;
  dir: string;
  daemon: WorkerDaemon;
  dOrch: Orchestrator;
  stop: () => Promise<void>;
}

async function startDaemon(
  allowCwd: string[],
  opts: { orphanGraceMs?: number } = {},
): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-remote-"));
  const dOrch = new Orchestrator(daemonConfig, { baseCwd: dir, persist: false });
  const daemon = new WorkerDaemon({
    config: daemonConfig,
    orchestrator: dOrch,
    host: "127.0.0.1",
    port: 0, // ephemeral
    token: TOKEN,
    allowCwd,
    orphanGraceMs: opts.orphanGraceMs,
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

/** Open an authenticated raw WebSocket to the daemon's /ws endpoint. */
function openWs(url: string): Promise<WS> {
  const ws = new WS(`${url.replace(/^http/, "ws")}/ws`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return new Promise((res, rej) => {
    ws.once("open", () => res(ws));
    ws.once("error", rej);
  });
}

/** Submit a task over a raw socket and resolve with its daemon-side taskId. */
function submitRaw(ws: WS, profile: string, prompt: string, cwd: string, timeoutMs = 30000): Promise<string> {
  const submitted = new Promise<string>((res) => {
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString()) as { type: string; taskId?: string };
      if (m.type === "submitted" && m.taskId) res(m.taskId);
    });
  });
  ws.send(JSON.stringify({ type: "submit", submitId: randomUUID(), profile, prompt, cwd, timeoutMs }));
  return submitted;
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

/* ------------------------- reconnect / reconciliation ------------------- */

/** Poll a daemon until a task reaches a terminal state (or the budget runs out). */
async function reconcile(
  remote: RemoteSettings,
  taskId: string,
  timeoutMs = 3000,
): Promise<TaskRecord | undefined> {
  const deadline = Date.now() + timeoutMs;
  let rec: TaskRecord | undefined;
  while (Date.now() < deadline) {
    rec = await queryRemoteTask(remote, taskId);
    if (rec && TERMINAL_TASK_STATUSES.has(rec.status)) return rec;
    await new Promise((r) => setTimeout(r, 25));
  }
  return rec;
}

test("query reconciles a completed task to its authoritative record", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-shared-"));
  const harness = await startDaemon([dir]);
  const orch = clientOrch(harness.url, dir);
  try {
    const res = await orch.dispatch({ profile: "r-fast", task: "analyze the remote module" });
    assert.equal(res.status, "completed");

    // The daemon ran exactly one local task; read its id from the daemon side.
    const remoteTasks = harness.dOrch.listTasks();
    assert.equal(remoteTasks.length, 1);
    const remoteTaskId = remoteTasks[0]!.taskId;

    // A brand-new connection (as after a reconnect) can fetch the real record.
    const rec = await queryRemoteTask({ endpoint: harness.url, tokenEnv: TOKEN_ENV }, remoteTaskId);
    assert.ok(rec, "expected an authoritative record");
    assert.equal(rec!.status, "succeeded");
    assert.match(rec!.text ?? "", /fast/);
  } finally {
    await orch.shutdown();
    await harness.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("query for an unknown task resolves undefined (not an error)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-shared-"));
  const harness = await startDaemon([dir]);
  try {
    const rec = await queryRemoteTask(
      { endpoint: harness.url, tokenEnv: TOKEN_ENV },
      "task-does-not-exist",
    );
    assert.equal(rec, undefined);
  } finally {
    await harness.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dropped connection reconciles to cancelled, never a false success", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-shared-"));
  const harness = await startDaemon([dir]);
  const remote: RemoteSettings = { endpoint: harness.url, tokenEnv: TOKEN_ENV };
  try {
    // Open a raw turn socket, submit a slow task, then yank the connection to
    // simulate network loss mid-run (no graceful close handshake).
    const wsUrl = `${harness.url.replace(/^http/, "ws")}/ws`;
    const ws = new WS(wsUrl, { headers: { authorization: `Bearer ${TOKEN}` } });
    await new Promise<void>((res, rej) => {
      ws.once("open", () => res());
      ws.once("error", rej);
    });
    const submitted = new Promise<string>((res) => {
      ws.on("message", (d) => {
        const m = JSON.parse(d.toString()) as { type: string; taskId?: string };
        if (m.type === "submitted" && m.taskId) res(m.taskId);
      });
    });
    ws.send(
      JSON.stringify({
        type: "submit",
        submitId: "s-drop",
        profile: "slow",
        prompt: "long remote work",
        cwd: dir,
        timeoutMs: 30000,
      }),
    );
    const taskId = await submitted;
    ws.terminate(); // abrupt drop

    // Reconcile over a fresh connection: the daemon must have cancelled the
    // orphaned task, so we read an authoritative non-success terminal state.
    const rec = await reconcile(remote, taskId);
    assert.ok(rec, "expected an authoritative record after reconnect");
    assert.notEqual(rec!.status, "succeeded", "a dropped running task must not read as success");
    assert.equal(rec!.status, "cancelled");
  } finally {
    await harness.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------- push-based resumption ------------------------ */

test("attach resumes a dropped-but-grace task and streams it to success", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-shared-"));
  const harness = await startDaemon([dir], { orphanGraceMs: 5000 });
  const remote: RemoteSettings = { endpoint: harness.url, tokenEnv: TOKEN_ENV };
  try {
    const ws = await openWs(harness.url);
    const taskId = await submitRaw(ws, "resumable", "resume me", dir);
    await new Promise((r) => setTimeout(r, 120)); // let some events accrue
    ws.terminate(); // abrupt drop mid-run

    const seen: number[] = [];
    const rec = await attachRemoteTask(remote, taskId, {
      afterSequence: 0,
      onEvent: (ev) => {
        seen.push(ev.sequence);
      },
    });
    assert.equal(rec.status, "succeeded", "grace window must keep the task alive to finish");
    assert.match(rec.text ?? "", /resumable/);
    assert.ok(seen.length > 0, "expected replayed + live events");
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i]! > seen[i - 1]!, `sequences must strictly increase: ${seen.join(",")}`);
    }
  } finally {
    await harness.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attach with afterSequence replays only newer events", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-shared-"));
  const harness = await startDaemon([dir]);
  const remote: RemoteSettings = { endpoint: harness.url, tokenEnv: TOKEN_ENV };
  try {
    // Run a fast task to completion over a raw socket, then detach.
    const ws = await openWs(harness.url);
    const taskId = await submitRaw(ws, "fast", "quick", dir);
    await new Promise<void>((res) => {
      ws.on("message", (d) => {
        const m = JSON.parse(d.toString()) as { type: string };
        if (m.type === "result") res();
      });
    });
    ws.close();

    // Full replay from 0 sees every event.
    const all: number[] = [];
    const rec1 = await attachRemoteTask(remote, taskId, { onEvent: (e) => all.push(e.sequence) });
    assert.equal(rec1.status, "succeeded");
    assert.ok(all.length > 0);
    const maxSeq = all[all.length - 1]!;

    // Resuming from the last sequence replays nothing new but still resolves.
    const none: number[] = [];
    const rec2 = await attachRemoteTask(remote, taskId, {
      afterSequence: maxSeq,
      onEvent: (e) => none.push(e.sequence),
    });
    assert.equal(rec2.status, "succeeded");
    assert.equal(none.length, 0, "no events should replay at or below afterSequence");
  } finally {
    await harness.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attach to an unknown task rejects", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-shared-"));
  const harness = await startDaemon([dir]);
  try {
    await assert.rejects(
      attachRemoteTask({ endpoint: harness.url, tokenEnv: TOKEN_ENV }, "task-does-not-exist"),
      /no such task|task_not_found/i,
    );
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
