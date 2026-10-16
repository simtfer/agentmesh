/**
 * Remote Worker Daemon end-to-end tests. Everything runs on loopback with mock
 * profiles — no real agents, no cost. Verifies the full proxy path: submit →
 * event stream → approval round-trip → cancel → result, plus the security guards
 * (token auth, workdir whitelist, insecure-bind refusal).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket as WS } from "ws";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { WorkerDaemon } from "../src/remote/daemon.js";
import { queryRemoteTask, attachRemoteTask, RemoteWorkerDriver } from "../src/remote/client.js";
import { assertCwdAllowed, assertSafeBind, SecurityError } from "../src/remote/security.js";
import { FileAuditLog, NoopAuditLog, type AuditLog } from "../src/remote/audit.js";
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
  opts: { orphanGraceMs?: number; tokenEnv?: string; audit?: AuditLog } = {},
): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-remote-"));
  const dOrch = new Orchestrator(daemonConfig, { baseCwd: dir, persist: false });
  const daemon = new WorkerDaemon({
    config: daemonConfig,
    orchestrator: dOrch,
    host: "127.0.0.1",
    port: 0, // ephemeral
    // tokenEnv makes the daemon resolve its accepted set from the environment on
    // every reloadTokens(); otherwise a single fixed test token is used.
    ...(opts.tokenEnv ? { tokenEnv: opts.tokenEnv } : { token: TOKEN }),
    allowCwd,
    orphanGraceMs: opts.orphanGraceMs,
    // Default to a no-op sink so the suite never litters an audit file on disk;
    // the dedicated audit test injects a real FileAuditLog.
    audit: opts.audit ?? new NoopAuditLog(),
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

/** Probe /profiles with a specific bearer token; returns the HTTP status. */
async function profilesStatus(url: string, token: string): Promise<number> {
  const r = await fetch(`${url}/profiles`, { headers: { authorization: `Bearer ${token}` } });
  return r.status;
}

/** Open an authenticated raw WS with an arbitrary token; resolves null on 401. */
function openWsWith(url: string, token: string): Promise<WS | null> {
  const ws = new WS(`${url.replace(/^http/, "ws")}/ws`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return new Promise((res) => {
    ws.once("open", () => res(ws));
    // A rejected upgrade surfaces as an error before any open event.
    ws.once("error", () => res(null));
    ws.once("unexpected-response", (_req, r) => res(r.statusCode === 101 ? ws : null));
  });
}

test("daemon accepts multiple valid tokens during a rotation", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-shared-"));
  const ROT_ENV = "AGENTMESH_ROT_TOKENS";
  process.env[ROT_ENV] = "old-secret, new-secret"; // comma-separated, whitespace tolerated
  const harness = await startDaemon([dir], { tokenEnv: ROT_ENV });
  try {
    // Both the old and the rotated-in token authorize over HTTP...
    assert.equal(await profilesStatus(harness.url, "old-secret"), 200);
    assert.equal(await profilesStatus(harness.url, "new-secret"), 200);
    // ...and a token that was never issued is still rejected.
    assert.equal(await profilesStatus(harness.url, "never-issued"), 401);

    // Both also pass the WebSocket upgrade; the bogus one does not connect.
    const wsOld = await openWsWith(harness.url, "old-secret");
    assert.ok(wsOld, "old token should upgrade");
    wsOld?.close();
    const wsNew = await openWsWith(harness.url, "new-secret");
    assert.ok(wsNew, "new token should upgrade");
    wsNew?.close();
    const wsBad = await openWsWith(harness.url, "never-issued");
    assert.equal(wsBad, null, "unissued token must be rejected at upgrade");
  } finally {
    await harness.stop();
    rmSync(dir, { recursive: true, force: true });
    delete process.env[ROT_ENV];
  }
});

test("reloadTokens() rotates credentials with no restart and refuses an empty set", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-shared-"));
  const ROT_ENV = "AGENTMESH_ROT_LIVE";
  // Start with only the old secret present in the environment.
  process.env[ROT_ENV] = "old-secret";
  const harness = await startDaemon([dir], { tokenEnv: ROT_ENV });
  try {
    assert.equal(await profilesStatus(harness.url, "old-secret"), 200);
    assert.equal(await profilesStatus(harness.url, "new-secret"), 401);

    // Operator adds the new secret alongside the old and triggers a reload.
    process.env[ROT_ENV] = "old-secret,new-secret";
    assert.equal(harness.daemon.reloadTokens(), 2);
    assert.equal(await profilesStatus(harness.url, "new-secret"), 200, "new token live after reload");
    assert.equal(await profilesStatus(harness.url, "old-secret"), 200, "old token still valid during overlap");

    // Operator drops the old secret and reloads again; it stops working, the
    // daemon never goes unauthenticated.
    process.env[ROT_ENV] = "new-secret";
    assert.equal(harness.daemon.reloadTokens(), 1);
    assert.equal(await profilesStatus(harness.url, "old-secret"), 401, "retired token rejected after reload");
    assert.equal(await profilesStatus(harness.url, "new-secret"), 200);

    // Rotating to an empty set is refused so the daemon can't be locked out or
    // silently become unauthenticated; the previous set keeps working.
    process.env[ROT_ENV] = "";
    assert.throws(() => harness.daemon.reloadTokens(), SecurityError);
    assert.equal(await profilesStatus(harness.url, "new-secret"), 200);
  } finally {
    await harness.stop();
    rmSync(dir, { recursive: true, force: true });
    delete process.env[ROT_ENV];
  }
});

/* ----------------------------- structured audit log --------------------- */

test("daemon writes a structured audit trail and never the token in cleartext", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-shared-"));
  const outside = mkdtempSync(path.join(tmpdir(), "agentmesh-outside-"));
  const auditFile = path.join(dir, "audit.ndjson");
  const audit = new FileAuditLog(auditFile, "daemon-audit-test");
  const harness = await startDaemon([dir], { audit });
  try {
    // 1. A good dispatch: auth_ok (ws) + connection_open + submit_ok.
    const orch = clientOrch(harness.url, dir);
    const res = await orch.dispatch({ profile: "r-fast", task: "audited run" });
    assert.equal(res.status, "completed");
    await orch.shutdown();

    // 2. A bad token at the HTTP surface: auth_fail with a fingerprint, not the value.
    process.env.AGENTMESH_AUDIT_BAD = "totally-wrong-token";
    assert.equal(await profilesStatus(harness.url, "totally-wrong-token"), 401);

    // 3. A working-directory escape: submit_rejected(cwd_not_whitelisted).
    const badOrch = clientOrch(harness.url, outside);
    const badRes = await badOrch.dispatch({ profile: "r-fast", task: "escape" });
    assert.equal(badRes.status, "failed");
    await badOrch.shutdown();
  } finally {
    // stop() records daemon_stop and flushes/closes the audit stream.
    await harness.stop();
  }

  const raw = readFileSync(auditFile, "utf8");
  const records = raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { event: string; [k: string]: unknown });
  const events = new Set(records.map((r) => r.event));

  // Control-plane decisions are all present and correlated to the daemon.
  for (const expected of [
    "daemon_start",
    "auth_ok",
    "connection_open",
    "submit_ok",
    "auth_fail",
    "submit_rejected",
    "daemon_stop",
  ]) {
    assert.ok(events.has(expected), `audit log missing ${expected}`);
  }
  assert.ok(records.every((r) => r.daemonId === "daemon-audit-test" && typeof r.ts === "string"));

  // The cwd escape was recorded with the offending path and reason.
  const rejected = records.find(
    (r) => r.event === "submit_rejected" && r.reason === "cwd_not_whitelisted",
  );
  assert.ok(rejected, "cwd refusal should be audited");

  // SECURITY: no secret ever reaches the log — neither the real token nor the
  // probe token, in cleartext. Fingerprints (hashed) are fine; values are not.
  assert.ok(!raw.includes(TOKEN), "audit log must not contain the real token");
  assert.ok(!raw.includes("totally-wrong-token"), "audit log must not contain the probe token");
  // The auth_fail record carries a non-reversible fingerprint instead.
  const fail = records.find((r) => r.event === "auth_fail") as { tokenFp?: string } | undefined;
  assert.ok(
    fail && typeof fail.tokenFp === "string" && fail.tokenFp.length === 12,
    "auth_fail should log a 12-hex fingerprint",
  );

  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  delete process.env.AGENTMESH_AUDIT_BAD;
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

test("runTurn transparently re-attaches after a mid-run drop (resume on)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-shared-"));
  const harness = await startDaemon([dir], { orphanGraceMs: 5000 });
  try {
    const profile = parseConfig({
      profiles: [
        {
          name: "r-resumable",
          driver: "remote",
          remote: {
            endpoint: harness.url,
            tokenEnv: TOKEN_ENV,
            remoteProfile: "resumable",
            resume: true,
            reconnectDelayMs: 80,
            reconnectAttempts: 3,
          },
        },
      ],
    }).profiles[0]!;

    const driver = new RemoteWorkerDriver();
    const handle = await driver.createWorker(profile, { id: "w-resume", cwd: dir });

    const notes: string[] = [];
    const turn = handle.runTurn("resume me transparently", {
      onEvent: (e) => {
        if (e.text) notes.push(e.text);
      },
    });

    // Let the socket open and the task start, then yank it mid-run.
    await new Promise((r) => setTimeout(r, 150));
    (handle as unknown as { activeWs?: WS }).activeWs?.terminate();

    const res = await turn;
    assert.equal(res.status, "completed", "turn should survive the drop via re-attach");
    assert.match(res.text, /resumable/);
    assert.ok(
      notes.some((t) => /re-attaching/i.test(t)),
      `expected a re-attach notice, got: ${notes.join(" | ")}`,
    );
    await handle.close();
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
