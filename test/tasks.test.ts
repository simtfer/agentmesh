import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { SqliteTaskStore } from "../src/store/sqlite.js";
import type { TaskStatus } from "../src/types.js";
import { DELEGATION_DEPTH_ENV } from "../src/types.js";

const TERMINAL: TaskStatus[] = ["succeeded", "failed", "cancelled", "timed_out"];

const config = parseConfig({
  workdir: ".agentmesh-test",
  profiles: [
    { name: "fast", driver: "mock", mock: { delayMs: 1, toolCalls: 1 } },
    { name: "slow", driver: "mock", mock: { delayMs: 40, toolCalls: 60 } },
    { name: "approver", driver: "mock", mock: { delayMs: 5, requireApproval: true } },
    { name: "flaky", driver: "mock", mock: { delayMs: 1, failOn: "boom" } },
  ],
});

const memOrch = () => new Orchestrator(config, { baseCwd: process.cwd(), persist: false });

test("happy path walks queued→starting→running→succeeded and persists events", async () => {
  const orch = memOrch();
  const sub = orch.submitTask({ profile: "fast", prompt: "do the thing" });
  assert.ok(["queued", "starting", "running"].includes(sub.status));

  const rec = await orch.waitTask(sub.taskId, 5000);
  assert.equal(rec?.status, "succeeded");
  assert.match(rec?.text ?? "", /fast/);
  assert.ok(rec?.finishedAt && rec.finishedAt >= (rec.startedAt ?? 0));

  const kinds = orch.taskEvents(sub.taskId).map((e) => e.type);
  assert.ok(kinds.includes("accepted"));
  assert.ok(kinds.includes("started"));
  assert.ok(kinds.includes("output"));
  assert.ok(kinds.includes("completed"));
  await orch.shutdown();
});

test("failing worker reports failed with error surfaced", async () => {
  const orch = memOrch();
  const sub = orch.submitTask({ profile: "flaky", prompt: "go boom" });
  const rec = await orch.waitTask(sub.taskId, 5000);
  assert.equal(rec?.status, "failed");
  assert.equal(rec?.error?.code, "MOCK_FAIL");
  await orch.shutdown();
});

test("timeout drives the task to timed_out", async () => {
  const orch = memOrch();
  const sub = orch.submitTask({ profile: "slow", prompt: "take forever", timeoutMs: 60 });
  const rec = await orch.waitTask(sub.taskId, 5000);
  assert.equal(rec?.status, "timed_out");
  assert.ok(TERMINAL.includes(rec!.status));
  await orch.shutdown();
});

test("cancel drives a running task to cancelled", async () => {
  const orch = memOrch();
  const sub = orch.submitTask({ profile: "slow", prompt: "long work", timeoutMs: 30000 });
  // let it reach running
  await new Promise((r) => setTimeout(r, 60));
  const rec = await orch.cancelTask(sub.taskId);
  assert.equal(rec?.status, "cancelled");
  await orch.shutdown();
});

test("waiting→approve→succeeded through the approval broker", async () => {
  const orch = memOrch();
  const sub = orch.submitTask({ profile: "approver", prompt: "risky refactor" });

  let rec = await orch.waitTask(sub.taskId, 2000);
  assert.equal(rec?.status, "waiting");
  assert.match(rec?.waitingReason ?? "", /permission/);

  const pending = orch.pendingApprovals(sub.taskId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.kind, "permission");

  assert.equal(orch.approveTask(pending[0]!.id, "allow_once"), true);

  const fin = await orch.waitTask(sub.taskId, 5000);
  assert.equal(fin?.status, "succeeded");

  const kinds = orch.taskEvents(sub.taskId).map((e) => e.type);
  assert.ok(kinds.includes("waiting"));
  assert.ok(kinds.includes("resumed"));
  await orch.shutdown();
});

test("rejecting a permission request fails the task", async () => {
  const orch = memOrch();
  const sub = orch.submitTask({ profile: "approver", prompt: "risky refactor" });
  await orch.waitTask(sub.taskId, 2000);
  const pending = orch.pendingApprovals(sub.taskId);
  orch.approveTask(pending[0]!.id, "reject_once");
  const fin = await orch.waitTask(sub.taskId, 5000);
  assert.equal(fin?.status, "failed");
  assert.equal(fin?.error?.code, "REJECTED");
  await orch.shutdown();
});

test("idempotencyKey de-duplicates a replayed submit", async () => {
  const orch = memOrch();
  const a = orch.submitTask({ profile: "fast", prompt: "once", idempotencyKey: "key-1" });
  const b = orch.submitTask({ profile: "fast", prompt: "once", idempotencyKey: "key-1" });
  assert.equal(a.taskId, b.taskId);
  await orch.waitTask(a.taskId, 5000);
  await orch.shutdown();
});

test("SQLite store survives an orchestrator restart (persist + re-query)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-"));
  try {
    const dbPath = path.join(dir, "agentmesh.sqlite");

    const orch1 = new Orchestrator(config, { baseCwd: process.cwd(), workdir: dir });
    const sub = orch1.submitTask({ profile: "fast", prompt: "persist me" });
    const rec = await orch1.waitTask(sub.taskId, 5000);
    assert.equal(rec?.status, "succeeded");
    await orch1.shutdown();
    assert.ok(existsSync(dbPath), "sqlite file should exist");

    // A brand-new orchestrator over the same workdir must see the finished task.
    const orch2 = new Orchestrator(config, { baseCwd: process.cwd(), workdir: dir });
    const reloaded = orch2.taskStatus(sub.taskId);
    assert.equal(reloaded?.status, "succeeded");
    assert.equal(reloaded?.prompt, "persist me");
    const kinds = orch2.taskEvents(sub.taskId).map((e) => e.type);
    assert.ok(kinds.includes("completed"));
    assert.ok(orch2.listTasks({ limit: 10 }).some((t) => t.taskId === sub.taskId));
    await orch2.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SqliteTaskStore update merges without clobbering unset columns", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-store-"));
  try {
    const store = new SqliteTaskStore(path.join(dir, "s.sqlite"));
    const now = Date.now();
    store.createTask({
      taskId: "t1", profile: "fast", prompt: "p", workingDirectory: dir,
      status: "queued", timeoutMs: 1000, createdAt: now, updatedAt: now,
    });
    store.updateTask("t1", { status: "running", startedAt: now });
    store.updateTask("t1", { status: "succeeded", text: "hello", finishedAt: now + 1 });
    const rec = store.getTask("t1")!;
    assert.equal(rec.status, "succeeded");
    assert.equal(rec.text, "hello");
    assert.equal(rec.startedAt, now, "startedAt must survive later updates");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------- recursion guard (PLAN §7) -------------------- */

// A shallow cap makes the depth limit easy to exercise with mock workers.
const shallowConfig = parseConfig({
  workdir: ".agentmesh-test",
  limits: { maxDelegationDepth: 2 },
  profiles: [{ name: "fast", driver: "mock", mock: { delayMs: 1, toolCalls: 1 } }],
});

const shallowOrch = () =>
  new Orchestrator(shallowConfig, { baseCwd: process.cwd(), persist: false });

test("delegation within the depth cap runs and stamps its depth in metadata", async () => {
  const orch = shallowOrch();
  try {
    // depth 0 (top-level master) and depth 1 (one hop down) are both < cap of 2.
    const d0 = orch.submitTask({ profile: "fast", prompt: "top level" });
    const r0 = await orch.waitTask(d0.taskId, 5000);
    assert.equal(r0?.status, "succeeded");
    assert.equal((r0?.metadata as Record<string, unknown>)?.delegationDepth, 0);

    const d1 = orch.submitTask({
      profile: "fast",
      prompt: "one hop",
      metadata: { delegationDepth: 1 },
    });
    const r1 = await orch.waitTask(d1.taskId, 5000);
    assert.equal(r1?.status, "succeeded");
    assert.equal((r1?.metadata as Record<string, unknown>)?.delegationDepth, 1);
  } finally {
    await orch.shutdown();
  }
});

test("submit at the depth cap is refused without spawning a worker", async () => {
  const orch = shallowOrch();
  try {
    const sub = orch.submitTask({
      profile: "fast",
      prompt: " recurse forever",
      metadata: { delegationDepth: 2 }, // == cap
    });
    // Refused synchronously — already terminal, no worker ever started.
    assert.equal(sub.status, "failed");
    assert.equal(sub.error?.code, "delegation_depth_exceeded");
    assert.equal(sub.workerId, undefined, "no worker should be spawned past the cap");

    const rec = await orch.waitTask(sub.taskId, 5000);
    assert.equal(rec?.status, "failed");
    assert.match(rec?.error?.message ?? "", /delegation depth 2 reaches the configured maximum 2/i);
    // The accepted-then-failed path is recorded, but no started/running events.
    const kinds = orch.taskEvents(sub.taskId).map((e) => e.type);
    assert.ok(kinds.includes("failed"));
    assert.ok(!kinds.includes("started"), "a refused delegation must not start a worker");
  } finally {
    await orch.shutdown();
  }
});

test("an inherited env depth raises the effective depth and trips the cap", async () => {
  const prev = process.env[DELEGATION_DEPTH_ENV];
  process.env[DELEGATION_DEPTH_ENV] = "2"; // this process is already 2 hops deep
  const orch = shallowOrch(); // base depth 2, cap 2 → any submit refused
  try {
    const sub = orch.submitTask({ profile: "fast", prompt: "too deep by inheritance" });
    assert.equal(sub.status, "failed");
    assert.equal(sub.error?.code, "delegation_depth_exceeded");
    // A caller-stamped depth cannot lower the inherited base (max wins).
    const sub2 = orch.submitTask({
      profile: "fast",
      prompt: "claims to be shallow",
      metadata: { delegationDepth: 0 },
    });
    assert.equal(sub2.status, "failed");
    assert.equal(sub2.error?.code, "delegation_depth_exceeded");
    assert.equal((sub2.metadata as Record<string, unknown>)?.delegationDepth, 2);
  } finally {
    await orch.shutdown();
    if (prev === undefined) delete process.env[DELEGATION_DEPTH_ENV];
    else process.env[DELEGATION_DEPTH_ENV] = prev;
  }
});

