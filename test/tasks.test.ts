import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
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

/* ------------------------- resource limits (PLAN §7) -------------------- */

// Tight caps make both guards easy to exercise with mock workers.
const limitedConfig = parseConfig({
  workdir: ".agentmesh-test",
  limits: { maxConcurrentTasks: 2, maxOutputBytes: 16 },
  profiles: [
    { name: "slow", driver: "mock", mock: { delayMs: 40, toolCalls: 60 } },
    { name: "fast", driver: "mock", mock: { delayMs: 1, toolCalls: 1 } },
    { name: "chatty", driver: "mock", mock: { delayMs: 1, reply: "A".repeat(200) } },
    { name: "unicode", driver: "mock", mock: { delayMs: 1, reply: "😀".repeat(50) } },
  ],
});

const limitedOrch = () =>
  new Orchestrator(limitedConfig, { baseCwd: process.cwd(), persist: false });

test("a submit beyond the concurrency cap is refused without spawning a worker", async () => {
  const orch = limitedOrch();
  try {
    // Two slow tasks occupy both in-flight slots.
    const a = orch.submitTask({ profile: "slow", prompt: "one", timeoutMs: 30000 });
    const b = orch.submitTask({ profile: "slow", prompt: "two", timeoutMs: 30000 });
    assert.notEqual(a.status, "failed");
    assert.notEqual(b.status, "failed");

    // The third is refused synchronously — never starts a worker.
    const c = orch.submitTask({ profile: "slow", prompt: "three", timeoutMs: 30000 });
    assert.equal(c.status, "failed");
    assert.equal(c.error?.code, "concurrency_limit_exceeded");
    assert.equal(c.workerId, undefined, "no worker should be spawned past the cap");
    const kinds = orch.taskEvents(c.taskId).map((e) => e.type);
    assert.ok(kinds.includes("failed"));
    assert.ok(!kinds.includes("started"), "a refused task must not start a worker");

    // Drain the two running tasks so shutdown is clean.
    await orch.waitTask(a.taskId, 10000);
    await orch.waitTask(b.taskId, 10000);
  } finally {
    await orch.shutdown();
  }
});

test("a task that settles frees its slot for the next submit", async () => {
  const orch = limitedOrch();
  try {
    const a = orch.submitTask({ profile: "fast", prompt: "one" });
    const b = orch.submitTask({ profile: "fast", prompt: "two" });
    await orch.waitTask(a.taskId, 5000);
    await orch.waitTask(b.taskId, 5000);
    // Both settled → live set is empty again → a new submit is accepted.
    const c = orch.submitTask({ profile: "fast", prompt: "three" });
    assert.notEqual(c.status, "failed");
    const rc = await orch.waitTask(c.taskId, 5000);
    assert.equal(rc?.status, "succeeded");
  } finally {
    await orch.shutdown();
  }
});

test("an oversized result is truncated and flagged outputTruncated", async () => {
  const orch = limitedOrch();
  try {
    const sub = orch.submitTask({ profile: "chatty", prompt: "say a lot" });
    const rec = await orch.waitTask(sub.taskId, 5000);
    assert.equal(rec?.status, "succeeded");
    assert.equal(rec?.outputTruncated, true);
    assert.ok(Buffer.byteLength(rec!.text ?? "", "utf8") <= 16);
    // A truncation note is recorded as an event for observability.
    const evs = orch.taskEvents(sub.taskId);
    assert.ok(
      evs.some((e) => e.type === "output" && (e.data as Record<string, unknown>)?.truncated === true),
      "expected a truncation output event",
    );
  } finally {
    await orch.shutdown();
  }
});

test("truncation never splits a multibyte codepoint", async () => {
  const orch = limitedOrch();
  try {
    const sub = orch.submitTask({ profile: "unicode", prompt: "emoji wall" });
    const rec = await orch.waitTask(sub.taskId, 5000);
    assert.equal(rec?.status, "succeeded");
    assert.equal(rec?.outputTruncated, true);
    // 16 bytes / 4 bytes-per-emoji = exactly 4 whole emoji, no replacement char.
    assert.equal(rec?.text, "😀😀😀😀");
    assert.ok(!(rec?.text ?? "").includes("\uFFFD"), "must not contain a replacement char");
  } finally {
    await orch.shutdown();
  }
});

/* --------------------- Stage 5: parallel scheduling --------------------- */

// A short-lived "hold" profile (~200ms/turn) keeps tasks running long enough to
// observe the queue, without slowing the suite down.
const hold = { delayMs: 25, toolCalls: 8 };

const schedConfig = parseConfig({
  workdir: ".agentmesh-test",
  limits: { maxConcurrentTasks: 2, maxQueuedTasks: 5 },
  profiles: [
    { name: "hold", driver: "mock", mock: hold },
    { name: "fast", driver: "mock", mock: { delayMs: 1, toolCalls: 1 } },
  ],
});

const schedOrch = () =>
  new Orchestrator(schedConfig, { baseCwd: process.cwd(), persist: false });

test("over-cap submits queue (not refuse) and drain FIFO as slots free", async () => {
  const orch = schedOrch();
  try {
    // Submit 4 synchronously: cap is 2, so 2 start and 2 wait in the queue.
    const a = orch.submitTask({ profile: "hold", prompt: "a" });
    const b = orch.submitTask({ profile: "hold", prompt: "b" });
    const c = orch.submitTask({ profile: "hold", prompt: "c" });
    const d = orch.submitTask({ profile: "hold", prompt: "d" });

    assert.equal(a.status, "starting");
    assert.equal(b.status, "starting");
    assert.equal(c.status, "queued", "over-cap submit should queue, not refuse");
    assert.equal(d.status, "queued");

    // scheduler_status reflects the split immediately (no awaits yet).
    const s = orch.schedulerStatus();
    assert.equal(s.running, 2);
    assert.equal(s.queued, 2);
    assert.equal(s.maxConcurrentTasks, 2);
    assert.equal(s.maxQueuedTasks, 5);
    assert.deepEqual(s.queuedTaskIds, [c.taskId, d.taskId], "queue order is FIFO by submit");

    // The queued tasks recorded their position for observability.
    const cq = orch.taskEvents(c.taskId).find((e) => e.type === "queued");
    assert.equal((cq?.data as Record<string, unknown>)?.queuePosition, 1);
    const dq = orch.taskEvents(d.taskId).find((e) => e.type === "queued");
    assert.equal((dq?.data as Record<string, unknown>)?.queuePosition, 2);

    // All four eventually succeed — the queue drains as running tasks settle.
    for (const t of [a, b, c, d]) {
      const rec = await orch.waitTask(t.taskId, 8000);
      assert.equal(rec?.status, "succeeded");
    }
    const end = orch.schedulerStatus();
    assert.equal(end.running, 0);
    assert.equal(end.queued, 0);
  } finally {
    await orch.shutdown();
  }
});

test("a submit with no slot AND a full queue is refused (queue_full)", async () => {
  const orch = new Orchestrator(
    parseConfig({
      workdir: ".agentmesh-test",
      limits: { maxConcurrentTasks: 1, maxQueuedTasks: 1 },
      profiles: [{ name: "hold", driver: "mock", mock: hold }],
    }),
    { baseCwd: process.cwd(), persist: false },
  );
  try {
    const a = orch.submitTask({ profile: "hold", prompt: "a" }); // runs (cap 1)
    const b = orch.submitTask({ profile: "hold", prompt: "b" }); // queues (1/1)
    assert.equal(a.status, "starting");
    assert.equal(b.status, "queued");

    const c = orch.submitTask({ profile: "hold", prompt: "c" }); // no slot, queue full
    assert.equal(c.status, "failed");
    assert.equal(c.error?.code, "queue_full");
    assert.equal(c.workerId, undefined, "a refused task never spawns a worker");
    assert.ok(!orch.taskEvents(c.taskId).some((e) => e.type === "started"));

    await orch.waitTask(a.taskId, 8000);
    await orch.waitTask(b.taskId, 8000);
  } finally {
    await orch.shutdown();
  }
});

test("cancelling a queued task settles immediately without the grace wait", async () => {
  const orch = new Orchestrator(
    parseConfig({
      workdir: ".agentmesh-test",
      limits: { maxConcurrentTasks: 1, maxQueuedTasks: 5 },
      profiles: [{ name: "hold", driver: "mock", mock: hold }],
    }),
    { baseCwd: process.cwd(), persist: false },
  );
  try {
    const a = orch.submitTask({ profile: "hold", prompt: "a" }); // runs
    const b = orch.submitTask({ profile: "hold", prompt: "b" }); // queued
    assert.equal(b.status, "queued");

    const t0 = Date.now();
    const cancelled = await orch.cancelTask(b.taskId);
    const elapsed = Date.now() - t0;

    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.workerId, undefined, "a queued task never spawned a worker");
    assert.ok(elapsed < 500, `queued cancel should be immediate, took ${elapsed}ms`);
    // It left the queue, so the scheduler no longer counts it.
    assert.equal(orch.schedulerStatus().queued, 0);

    // The running task is unaffected and still completes.
    const ra = await orch.waitTask(a.taskId, 8000);
    assert.equal(ra?.status, "succeeded");
  } finally {
    await orch.shutdown();
  }
});

test("fan-out up to the cap runs concurrently, bounded by maxConcurrentTasks", async () => {
  const orch = new Orchestrator(
    parseConfig({
      workdir: ".agentmesh-test",
      limits: { maxConcurrentTasks: 3, maxQueuedTasks: 10 },
      profiles: [{ name: "hold", driver: "mock", mock: hold }],
    }),
    { baseCwd: process.cwd(), persist: false },
  );
  try {
    const subs = [1, 2, 3, 4, 5].map((n) =>
      orch.submitTask({ profile: "hold", prompt: `t${n}` }),
    );
    // Exactly 3 run at once; the other 2 wait — never more than the cap.
    const s = orch.schedulerStatus();
    assert.equal(s.running, 3, "concurrency must not exceed the cap");
    assert.equal(s.queued, 2);

    for (const t of subs) {
      const rec = await orch.waitTask(t.taskId, 8000);
      assert.equal(rec?.status, "succeeded");
    }
  } finally {
    await orch.shutdown();
  }
});

/* --------------------- Phase 1: cross-worker handoff --------------------- */

// A unique token used as a behavioural probe: the mock "tripwire" profile fails
// iff it sees this token in the prompt it receives, so a fired tripwire is proof
// the predecessor's result was actually injected into the successor's prompt.
const TOKEN = "HANDOFF_TOKEN_42";

const handoffConfig = parseConfig({
  workdir: ".agentmesh-test",
  limits: { maxHandoffBytes: 256 * 1024 },
  profiles: [
    { name: "echo", driver: "mock", mock: { delayMs: 1, toolCalls: 1 } },
    { name: "tripwire", driver: "mock", mock: { delayMs: 1, failOn: TOKEN } },
    { name: "slowhs", driver: "mock", mock: { delayMs: 40, toolCalls: 60 } },
  ],
});

const hsOrch = () =>
  new Orchestrator(handoffConfig, { baseCwd: process.cwd(), persist: false });

test("handoff injects the predecessor result into the successor prompt", async () => {
  const orch = hsOrch();
  try {
    // The mock echoes the first 80 chars of its prompt, so the predecessor's
    // result text carries the token.
    const pred = orch.submitTask({ profile: "echo", prompt: `please output ${TOKEN} verbatim` });
    const predRec = await orch.waitTask(pred.taskId, 5000);
    assert.equal(predRec?.status, "succeeded");
    assert.ok((predRec?.text ?? "").includes(TOKEN), "predecessor result should carry the token");

    // The tripwire successor fails iff it sees the token → proves injection.
    const succ = orch.submitTask({
      profile: "tripwire",
      prompt: "do some unrelated work",
      handoff: { fromTaskId: pred.taskId, inject: "result" },
    });
    const succRec = await orch.waitTask(succ.taskId, 5000);
    assert.equal(succRec?.status, "failed");
    assert.equal(succRec?.error?.code, "MOCK_FAIL", "tripwire fired → token reached the successor");
  } finally {
    await orch.shutdown();
  }
});

test("without handoff the same tripwire successor never sees the token", async () => {
  const orch = hsOrch();
  try {
    const succ = orch.submitTask({ profile: "tripwire", prompt: "do some unrelated work" });
    const rec = await orch.waitTask(succ.taskId, 5000);
    assert.equal(rec?.status, "succeeded", "no handoff → no token → tripwire stays green");
  } finally {
    await orch.shutdown();
  }
});

test("handoff wraps the artifact as untrusted and keeps the stored prompt original", async () => {
  const orch = hsOrch();
  try {
    const pred = orch.submitTask({ profile: "echo", prompt: "some upstream finding" });
    await orch.waitTask(pred.taskId, 5000);

    const succ = orch.submitTask({
      profile: "echo",
      prompt: "ORIGINAL_SUCCESSOR_PROMPT",
      handoff: { fromTaskId: pred.taskId },
    });
    const rec = await orch.waitTask(succ.taskId, 5000);
    assert.equal(rec?.status, "succeeded");
    // The mock echoes the first 80 chars of the prompt it actually received, so
    // the untrusted envelope (marker + trusted=NO) must be prepended.
    assert.match(rec?.text ?? "", /<<<UPSTREAM WORKER OUTPUT/);
    assert.match(rec?.text ?? "", /trusted=NO/);

    // Decision #2: the persisted prompt stays the user's original — the envelope
    // is ephemeral, so a large/secret-bearing artifact never lands in the store.
    const stored = orch.taskStatus(succ.taskId);
    assert.equal(stored?.prompt, "ORIGINAL_SUCCESSOR_PROMPT");
    assert.ok(!(stored?.prompt ?? "").includes("UPSTREAM WORKER OUTPUT"));

    // Observability: a `handoff` event + a compact metadata summary.
    assert.ok(orch.taskEvents(succ.taskId).some((e) => e.type === "handoff"));
    const ho = (stored?.metadata as Record<string, unknown>)?.handoff as Record<string, unknown>;
    assert.equal(ho?.fromTaskId, pred.taskId);
    assert.equal(ho?.inject, "result");
    assert.equal(ho?.base, "repo");
  } finally {
    await orch.shutdown();
  }
});

test("handoff from a non-succeeded predecessor is refused without spawning", async () => {
  const orch = hsOrch();
  try {
    const pred = orch.submitTask({ profile: "slowhs", prompt: "long running", timeoutMs: 30000 });
    // Predecessor is still in flight (not `succeeded`) → successor refused fast.
    const succ = orch.submitTask({
      profile: "echo",
      prompt: "chain attempt",
      handoff: { fromTaskId: pred.taskId },
    });
    assert.equal(succ.status, "failed");
    assert.equal(succ.error?.code, "handoff_predecessor_not_ready");
    await orch.cancelTask(pred.taskId);
  } finally {
    await orch.shutdown();
  }
});

test("handoff from an unknown task is refused", async () => {
  const orch = hsOrch();
  try {
    const succ = orch.submitTask({
      profile: "echo",
      prompt: "chain attempt",
      handoff: { fromTaskId: "no-such-task" },
    });
    assert.equal(succ.status, "failed");
    assert.equal(succ.error?.code, "handoff_unknown_task");
  } finally {
    await orch.shutdown();
  }
});

test("handoff artifact is capped to maxBytes and flagged truncated", async () => {
  const orch = hsOrch();
  try {
    const pred = orch.submitTask({ profile: "echo", prompt: "x".repeat(200) });
    const predRec = await orch.waitTask(pred.taskId, 5000);
    assert.ok((predRec?.text ?? "").length > 40, "predecessor result should be sizable");

    const succ = orch.submitTask({
      profile: "echo",
      prompt: "consume upstream",
      handoff: { fromTaskId: pred.taskId, maxBytes: 16 },
    });
    const rec = await orch.waitTask(succ.taskId, 5000);
    assert.equal(rec?.status, "succeeded");
    const ho = (orch.taskStatus(succ.taskId)?.metadata as Record<string, unknown>)?.handoff as
      | Record<string, unknown>
      | undefined;
    assert.equal(ho?.truncated, true);
    assert.ok((ho?.injectedBytes as number) <= 16, `injected ${ho?.injectedBytes} must be <= 16`);
  } finally {
    await orch.shutdown();
  }
});

test("an old-schema SQLite DB is forward-migrated with the deadlineAt column", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-mig-"));
  try {
    const dbPath = path.join(dir, "old.sqlite");
    // A `tasks` table exactly as v0.1 created it — no deadlineAt column.
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE tasks (
      taskId TEXT PRIMARY KEY, profile TEXT NOT NULL, workerId TEXT, prompt TEXT NOT NULL,
      workingDirectory TEXT NOT NULL, status TEXT NOT NULL, sessionId TEXT, idempotencyKey TEXT,
      timeoutMs INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      startedAt INTEGER, finishedAt INTEGER, text TEXT, stopReason TEXT, waitingReason TEXT,
      errorCode TEXT, errorMessage TEXT, errorRetryable INTEGER, metadata TEXT)`);
    db.exec(`INSERT INTO tasks (taskId, profile, prompt, workingDirectory, status, timeoutMs, createdAt, updatedAt)
      VALUES ('old-1','p','x','/tmp','succeeded',1000,1,2)`);
    db.close();

    const store = new SqliteTaskStore(dbPath);
    try {
      const rec = store.getTask("old-1");
      assert.equal(rec?.status, "succeeded");
      assert.equal(rec?.deadlineAt, undefined, "rows written before the migration have no deadline");
      store.updateTask("old-1", { deadlineAt: 123456 });
      assert.equal(store.getTask("old-1")?.deadlineAt, 123456);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --------- Stage 5.1: queue TTL, per-task deadlines, weighted fairness -------- */

const boundedOrch = (
  limits: { maxConcurrentTasks?: number; maxQueuedTasks?: number; queueTtlMs?: number },
  profiles: Array<Record<string, unknown>>,
) =>
  new Orchestrator(parseConfig({ workdir: ".agentmesh-test", limits, profiles }), {
    baseCwd: process.cwd(),
    persist: false,
  });

test("a queued task expires at the queue TTL without ever spawning a worker", async () => {
  const orch = boundedOrch({ maxConcurrentTasks: 1, maxQueuedTasks: 4, queueTtlMs: 60 }, [
    { name: "hold", driver: "mock", mock: hold },
  ]);
  try {
    const a = orch.submitTask({ profile: "hold", prompt: "a" });
    const b = orch.submitTask({ profile: "hold", prompt: "b" });
    assert.equal(a.status, "starting");
    assert.equal(b.status, "queued");

    const s = orch.schedulerStatus();
    assert.equal(s.queueTtlMs, 60);
    assert.equal(s.fairness, "fifo", "default weights keep strict FIFO");
    assert.equal(s.queuedTasks[0]?.taskId, b.taskId);

    const rb = await orch.waitTask(b.taskId, 4000);
    assert.equal(rb?.status, "timed_out");
    assert.equal(rb?.error?.code, "queue_ttl_exceeded");
    assert.equal(rb?.workerId, undefined, "an expired queue entry never spawns a worker");
    assert.ok(!orch.taskEvents(b.taskId).some((e) => e.type === "started"));
    assert.equal(orch.schedulerStatus().queued, 0, "it must leave the queue");

    const ra = await orch.waitTask(a.taskId, 8000);
    assert.equal(ra?.status, "succeeded", "the running task is unaffected");
  } finally {
    await orch.shutdown();
  }
});

test("a per-task deadline expires a task that never got a slot", async () => {
  const orch = boundedOrch({ maxConcurrentTasks: 1, maxQueuedTasks: 4 }, [
    { name: "hold", driver: "mock", mock: hold },
  ]);
  try {
    const a = orch.submitTask({ profile: "hold", prompt: "a" });
    const b = orch.submitTask({ profile: "hold", prompt: "b", deadlineMs: 60 });
    assert.equal(b.status, "queued");
    assert.ok((b.deadlineAt ?? 0) > b.createdAt, "the deadline is persisted on the record");

    const rb = await orch.waitTask(b.taskId, 4000);
    assert.equal(rb?.status, "timed_out");
    assert.equal(rb?.error?.code, "deadline_exceeded");
    assert.equal(rb?.workerId, undefined);

    await orch.waitTask(a.taskId, 8000);
  } finally {
    await orch.shutdown();
  }
});

test("a per-task deadline bounds a running turn and reports deadline_exceeded", async () => {
  const orch = boundedOrch({ maxConcurrentTasks: 0, maxQueuedTasks: 0 }, [
    { name: "hold", driver: "mock", mock: hold },
  ]);
  try {
    const t0 = Date.now();
    // timeoutMs is far larger than the deadline: the deadline must be what fires.
    const sub = orch.submitTask({
      profile: "hold",
      prompt: "slow work",
      timeoutMs: 30000,
      deadlineMs: 80,
    });
    const rec = await orch.waitTask(sub.taskId, 5000);
    const elapsed = Date.now() - t0;

    assert.equal(rec?.status, "timed_out");
    assert.equal(rec?.error?.code, "deadline_exceeded", "the deadline, not the timeout, fired");
    assert.ok(elapsed < 2000, `deadline should fire early, took ${elapsed}ms`);
  } finally {
    await orch.shutdown();
  }
});

test("a submit whose deadline already passed is refused outright", async () => {
  const orch = boundedOrch({ maxConcurrentTasks: 0, maxQueuedTasks: 4 }, [
    { name: "hold", driver: "mock", mock: hold },
  ]);
  try {
    const s = orch.submitTask({ profile: "hold", prompt: "too late", deadlineAt: Date.now() - 1000 });
    assert.equal(s.status, "failed");
    assert.equal(s.error?.code, "deadline_exceeded");
    assert.equal(s.workerId, undefined);
    assert.equal(orch.schedulerStatus().queued, 0);
  } finally {
    await orch.shutdown();
  }
});

test("configured profile weights reorder the queue by weighted fair share", async () => {
  const limits = { maxConcurrentTasks: 1, maxQueuedTasks: 20 };
  const plain = boundedOrch(limits, [
    { name: "heavy", driver: "mock", mock: hold },
    { name: "light", driver: "mock", mock: hold },
  ]);
  const weighted = boundedOrch(limits, [
    { name: "heavy", driver: "mock", weight: 3, mock: hold },
    { name: "light", driver: "mock", mock: hold },
  ]);
  // Same submit pattern for both: one task takes the only slot, then an even mix
  // of heavy/light work waits behind it.
  const fill = (orch: Orchestrator) => {
    orch.submitTask({ profile: "heavy", prompt: "h1" }); // starts, not queued
    return {
      l1: orch.submitTask({ profile: "light", prompt: "l1" }),
      h2: orch.submitTask({ profile: "heavy", prompt: "h2" }),
      l2: orch.submitTask({ profile: "light", prompt: "l2" }),
      h3: orch.submitTask({ profile: "heavy", prompt: "h3" }),
      l3: orch.submitTask({ profile: "light", prompt: "l3" }),
      h4: orch.submitTask({ profile: "heavy", prompt: "h4" }),
      l4: orch.submitTask({ profile: "light", prompt: "l4" }),
    };
  };
  try {
    const p = fill(plain);
    const ps = plain.schedulerStatus();
    assert.equal(ps.fairness, "fifo");
    assert.deepEqual(ps.queuedTaskIds, [p.l1, p.h2, p.l2, p.h3, p.l3, p.h4, p.l4].map((t) => t.taskId));

    const w = fill(weighted);
    const ws = weighted.schedulerStatus();
    assert.equal(ws.fairness, "weighted");
    // Weight 3 accumulates finish tags three times as slowly, so the heavy
    // profile takes 3 of the first 4 dispatch slots instead of alternating.
    assert.deepEqual(ws.queuedTaskIds.slice(0, 4), [w.h2, w.h3, w.l1, w.h4].map((t) => t.taskId));
    assert.equal(ws.queuedTasks[0]?.weight, 3);
    assert.equal(ws.queuedTasks.find((q) => q.taskId === w.l1.taskId)?.weight, 1);
  } finally {
    await plain.shutdown();
    await weighted.shutdown();
  }
});




