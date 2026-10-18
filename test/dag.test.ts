/**
 * Stage 5 advanced scheduling: DAG dependencies and automatic retry.
 *
 * Both features change *when* a task runs, so every test drives the public
 * surface (submit → wait → events/record) rather than poking manager internals.
 * The mock driver's `failFirst` knob is what makes retries observable: it fails
 * the profile's first N turns across workers, i.e. a transient upstream failure
 * that a re-run can recover from — which `failOn` (prompt-based) cannot express.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { SqliteTaskStore } from "../src/store/sqlite.js";
import type { TaskRecord } from "../src/types.js";

/** ~200ms of work: long enough to hold the only concurrency slot. */
const hold = { delayMs: 30, toolCalls: 6 };
const fast = { delayMs: 1, toolCalls: 1 };

const make = (
  limits: Record<string, number>,
  profiles: Array<Record<string, unknown>>,
): Orchestrator =>
  new Orchestrator(parseConfig({ workdir: ".agentmesh-test", limits, profiles }), {
    baseCwd: process.cwd(),
    persist: false,
  });

const attemptsOf = (rec: TaskRecord | undefined): Array<Record<string, unknown>> =>
  (rec?.metadata?.attempts as Array<Record<string, unknown>> | undefined) ?? [];

/* ----------------------------- dependencies ----------------------------- */

test("a dependency-blocked task waits for its predecessor, then runs", async () => {
  const orch = make({ maxConcurrentTasks: 5, maxQueuedTasks: 5 }, [
    { name: "fast", driver: "mock", mock: fast },
  ]);
  try {
    const a = orch.submitTask({ profile: "fast", prompt: "first" });
    const b = orch.submitTask({ profile: "fast", prompt: "second", dependsOn: [a.taskId] });

    assert.equal(b.status, "queued", "a gated task is accepted, not started");
    assert.deepEqual(b.dependsOn, [a.taskId]);
    assert.deepEqual(b.blockedBy, [a.taskId]);

    const s = orch.schedulerStatus();
    assert.equal(s.blocked, 1);
    assert.equal(s.queued, 0, "a gated task is not in the dispatch queue");
    assert.deepEqual(s.blockedTasks.map((t) => t.taskId), [b.taskId]);
    assert.deepEqual(s.blockedTasks[0]?.waitingOn, [a.taskId]);

    const rb = await orch.waitTask(b.taskId, 8000);
    assert.equal(rb?.status, "succeeded");
    assert.deepEqual(rb?.blockedBy, [], "the gate clears once the predecessor succeeds");

    const types = orch.taskEvents(b.taskId).map((e) => e.type);
    assert.ok(types.indexOf("dependency") >= 0, "the release is recorded");
    assert.ok(types.indexOf("dependency") < types.indexOf("started"), "released, then started");
  } finally {
    await orch.shutdown();
  }
});

test("a failed dependency fails its dependents, cascading down the chain", async () => {
  const orch = make({ maxConcurrentTasks: 5, maxQueuedTasks: 10 }, [
    { name: "flaky", driver: "mock", mock: { delayMs: 1, failOn: "boom" } },
    { name: "fast", driver: "mock", mock: fast },
  ]);
  try {
    const a = orch.submitTask({ profile: "flaky", prompt: "go boom" });
    const b = orch.submitTask({ profile: "fast", prompt: "b", dependsOn: [a.taskId] });
    const c = orch.submitTask({ profile: "fast", prompt: "c", dependsOn: [b.taskId] });
    assert.equal(b.status, "queued");
    assert.equal(c.status, "queued");

    const rb = await orch.waitTask(b.taskId, 8000);
    assert.equal(rb?.status, "failed");
    assert.equal(rb?.error?.code, "dependency_failed");
    assert.equal(rb?.workerId, undefined, "a task whose gate failed never spawns a worker");
    assert.ok(!orch.taskEvents(b.taskId).some((e) => e.type === "started"));

    // The failure cascades: c depended on b, so b's death has to settle c too
    // instead of leaving it blocked forever.
    const rc = await orch.waitTask(c.taskId, 8000);
    assert.equal(rc?.status, "failed");
    assert.equal(rc?.error?.code, "dependency_failed");
    assert.match(rc?.error?.message ?? "", new RegExp(b.taskId));

    assert.equal(orch.schedulerStatus().blocked, 0, "no gated task is left behind");
  } finally {
    await orch.shutdown();
  }
});

test("cancelling a dependency fails its dependents instead of stranding them", async () => {
  const orch = make({ maxConcurrentTasks: 5, maxQueuedTasks: 5 }, [
    { name: "hold", driver: "mock", mock: hold },
    { name: "fast", driver: "mock", mock: fast },
  ]);
  try {
    const a = orch.submitTask({ profile: "hold", prompt: "a" });
    const b = orch.submitTask({ profile: "fast", prompt: "b", dependsOn: [a.taskId] });
    assert.equal(b.status, "queued");

    await orch.cancelTask(a.taskId);
    const rb = await orch.waitTask(b.taskId, 4000);
    assert.equal(rb?.status, "failed");
    assert.equal(rb?.error?.code, "dependency_failed");
    assert.match(rb?.error?.message ?? "", /cancelled/);
  } finally {
    await orch.shutdown();
  }
});

test("a blocked task can be cancelled immediately and never wakes up", async () => {
  const orch = make({ maxConcurrentTasks: 5, maxQueuedTasks: 5 }, [
    { name: "hold", driver: "mock", mock: hold },
    { name: "fast", driver: "mock", mock: fast },
  ]);
  try {
    const a = orch.submitTask({ profile: "hold", prompt: "a" });
    const b = orch.submitTask({ profile: "fast", prompt: "b", dependsOn: [a.taskId] });

    const t0 = Date.now();
    const cancelled = await orch.cancelTask(b.taskId);
    const elapsed = Date.now() - t0;
    assert.equal(cancelled?.status, "cancelled");
    assert.ok(elapsed < 500, `a blocked cancel should not wait for a worker, took ${elapsed}ms`);
    assert.equal(orch.schedulerStatus().blocked, 0);

    // The predecessor finishing later must not resurrect the cancelled task.
    const ra = await orch.waitTask(a.taskId, 8000);
    assert.equal(ra?.status, "succeeded");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(orch.taskStatus(b.taskId)?.status, "cancelled");
    assert.ok(!orch.taskEvents(b.taskId).some((e) => e.type === "started"));
  } finally {
    await orch.shutdown();
  }
});

test("dependencies without a queue are refused (nothing to wait in)", async () => {
  const orch = make({ maxConcurrentTasks: 2 }, [{ name: "fast", driver: "mock", mock: fast }]);
  try {
    const a = orch.submitTask({ profile: "fast", prompt: "a" });
    const b = orch.submitTask({ profile: "fast", prompt: "b", dependsOn: [a.taskId] });
    assert.equal(b.status, "failed");
    assert.equal(b.error?.code, "dependency_requires_queue");
    assert.equal(b.workerId, undefined);
    await orch.waitTask(a.taskId, 5000);
  } finally {
    await orch.shutdown();
  }
});

test("unknown, already-failed and oversized dependency lists are refused at submit", async () => {
  const orch = make({ maxConcurrentTasks: 5, maxQueuedTasks: 10, maxDependencies: 1 }, [
    { name: "fast", driver: "mock", mock: fast },
    { name: "flaky", driver: "mock", mock: { delayMs: 1, failOn: "boom" } },
  ]);
  try {
    const unknown = orch.submitTask({ profile: "fast", prompt: "x", dependsOn: ["no-such-task"] });
    assert.equal(unknown.status, "failed");
    assert.equal(unknown.error?.code, "dependency_unknown_task");

    // A predecessor that failed can never satisfy a gate: fail now, not later.
    const dead = orch.submitTask({ profile: "flaky", prompt: "go boom" });
    await orch.waitTask(dead.taskId, 5000);
    const doomed = orch.submitTask({ profile: "fast", prompt: "y", dependsOn: [dead.taskId] });
    assert.equal(doomed.status, "failed");
    assert.equal(doomed.error?.code, "dependency_failed");

    const a = orch.submitTask({ profile: "fast", prompt: "a" });
    const b = orch.submitTask({ profile: "fast", prompt: "b" });
    const tooMany = orch.submitTask({
      profile: "fast",
      prompt: "c",
      dependsOn: [a.taskId, b.taskId],
    });
    assert.equal(tooMany.status, "failed");
    assert.equal(tooMany.error?.code, "dependency_limit_exceeded");

    await orch.waitTask(a.taskId, 5000);
    await orch.waitTask(b.taskId, 5000);
    assert.equal(orch.schedulerStatus().blocked, 0);
  } finally {
    await orch.shutdown();
  }
});

test("blocked tasks consume queue capacity, so a deep DAG is still bounded", async () => {
  const orch = make({ maxConcurrentTasks: 1, maxQueuedTasks: 1 }, [
    { name: "hold", driver: "mock", mock: hold },
  ]);
  try {
    const a = orch.submitTask({ profile: "hold", prompt: "a" }); // running
    const b = orch.submitTask({ profile: "hold", prompt: "b", dependsOn: [a.taskId] }); // gated, 1/1
    assert.equal(b.status, "queued");

    const c = orch.submitTask({ profile: "hold", prompt: "c", dependsOn: [a.taskId] });
    assert.equal(c.status, "failed");
    assert.equal(c.error?.code, "queue_full");
    assert.equal(c.workerId, undefined);

    await orch.waitTask(a.taskId, 8000);
    await orch.waitTask(b.taskId, 8000);
  } finally {
    await orch.shutdown();
  }
});

test("a deadline that elapses while blocked times out without spawning a worker", async () => {
  const orch = make({ maxConcurrentTasks: 1, maxQueuedTasks: 5 }, [
    { name: "hold", driver: "mock", mock: hold },
    { name: "fast", driver: "mock", mock: fast },
  ]);
  try {
    const a = orch.submitTask({ profile: "hold", prompt: "a" });
    const b = orch.submitTask({
      profile: "fast",
      prompt: "b",
      dependsOn: [a.taskId],
      deadlineMs: 60,
    });
    assert.equal(b.status, "queued");

    const rb = await orch.waitTask(b.taskId, 4000);
    assert.equal(rb?.status, "timed_out");
    assert.equal(rb?.error?.code, "deadline_exceeded");
    assert.equal(rb?.workerId, undefined);
    assert.equal(orch.schedulerStatus().blocked, 0);

    await orch.waitTask(a.taskId, 8000);
  } finally {
    await orch.shutdown();
  }
});

test("the queue TTL starts when a task becomes ready, not while it waits on dependencies", async () => {
  const orch = make({ maxConcurrentTasks: 1, maxQueuedTasks: 5, queueTtlMs: 60 }, [
    { name: "hold", driver: "mock", mock: hold }, // ~200ms, far longer than the TTL
    { name: "fast", driver: "mock", mock: fast },
  ]);
  try {
    const a = orch.submitTask({ profile: "hold", prompt: "a" });
    const b = orch.submitTask({ profile: "fast", prompt: "b", dependsOn: [a.taskId] });
    const rb = await orch.waitTask(b.taskId, 8000);
    assert.equal(
      rb?.status,
      "succeeded",
      "waiting on a slow predecessor is not queue starvation, so the TTL must not fire",
    );
    assert.ok((rb?.startedAt ?? 0) - (rb?.createdAt ?? 0) > 100, "it really did wait on the gate");
  } finally {
    await orch.shutdown();
  }
});

/* -------------------------------- retry --------------------------------- */

test("a retry policy runs the task maxAttempts times and then settles failed", async () => {
  const orch = make({}, [{ name: "flaky", driver: "mock", mock: { delayMs: 1, failOn: "boom" } }]);
  try {
    const sub = orch.submitTask({
      profile: "flaky",
      prompt: "go boom",
      retry: { maxAttempts: 3 },
    });
    const rec = await orch.waitTask(sub.taskId, 10000);

    assert.equal(rec?.status, "failed");
    assert.equal(rec?.error?.code, "MOCK_FAIL");
    assert.equal(rec?.attempt, 3);
    assert.equal(rec?.maxAttempts, 3);

    const events = orch.taskEvents(sub.taskId);
    assert.equal(events.filter((e) => e.type === "retry").length, 2, "one retry event per re-run");
    assert.equal(events.filter((e) => e.type === "started").length, 3);
    // Failed attempts are archived, so their errors are not lost when the record
    // is reset for the next run.
    const attempts = attemptsOf(rec);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.status, "failed");
    assert.equal(attempts[0]?.code, "MOCK_FAIL");
  } finally {
    await orch.shutdown();
  }
});

test("a transient failure is recovered by the next attempt", async () => {
  const orch = make({}, [{ name: "wobbly", driver: "mock", mock: { delayMs: 1, failFirst: 1 } }]);
  try {
    const sub = orch.submitTask({
      profile: "wobbly",
      prompt: "do the thing",
      retry: { maxAttempts: 3 },
    });
    const rec = await orch.waitTask(sub.taskId, 10000);

    assert.equal(rec?.status, "succeeded");
    assert.equal(rec?.attempt, 2, "it took two attempts");
    assert.match(rec?.text ?? "", /wobbly/);
    assert.equal(rec?.error, undefined, "the failed attempt's error must not stick");
    assert.equal(rec?.finishedAt !== undefined, true);

    const attempts = attemptsOf(rec);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.status, "failed");
    assert.equal(orch.taskEvents(sub.taskId).filter((e) => e.type === "retry").length, 1);
  } finally {
    await orch.shutdown();
  }
});

test("backoff delays the next attempt until retryAt", async () => {
  const orch = make({}, [{ name: "wobbly", driver: "mock", mock: { delayMs: 1, failFirst: 1 } }]);
  try {
    const sub = orch.submitTask({
      profile: "wobbly",
      prompt: "slow retry",
      retry: { maxAttempts: 2, delayMs: 80 },
    });
    const rec = await orch.waitTask(sub.taskId, 10000);
    assert.equal(rec?.status, "succeeded");
    assert.equal(rec?.attempt, 2);

    const events = orch.taskEvents(sub.taskId);
    const retry = events.find((e) => e.type === "retry");
    const retryAt = (retry?.data as Record<string, unknown> | undefined)?.retryAt as number;
    assert.ok(retryAt > 0, "the record carries when the next attempt may start");
    const started = events.filter((e) => e.type === "started");
    assert.equal(started.length, 2);
    assert.ok(
      Date.parse(started[1]!.timestamp) >= retryAt - 5,
      `attempt 2 started at ${started[1]!.timestamp}, before retryAt ${new Date(retryAt).toISOString()}`,
    );
  } finally {
    await orch.shutdown();
  }
});

test("a deadline that elapses during a retry backoff settles timed_out", async () => {
  const orch = make({}, [{ name: "wobbly", driver: "mock", mock: { delayMs: 1, failFirst: 1 } }]);
  try {
    const sub = orch.submitTask({
      profile: "wobbly",
      prompt: "out of time",
      deadlineMs: 120,
      retry: { maxAttempts: 3, delayMs: 5000 },
    });
    const rec = await orch.waitTask(sub.taskId, 6000);
    assert.equal(rec?.status, "timed_out");
    assert.equal(rec?.error?.code, "deadline_exceeded");
    assert.equal(rec?.attempt, 2, "the retry was scheduled, then the budget ran out");
    assert.equal(
      orch.taskEvents(sub.taskId).filter((e) => e.type === "started").length,
      1,
      "the second attempt never started",
    );
  } finally {
    await orch.shutdown();
  }
});

test("usage is summed across attempts, because each attempt really spent it", async () => {
  const orch = make({}, [
    {
      name: "metered",
      driver: "mock",
      mock: {
        delayMs: 1,
        failFirst: 1,
        usage: { cost: { amount: 1, currency: "USD" }, inputTokens: 10, reports: 1 },
      },
    },
  ]);
  try {
    const sub = orch.submitTask({
      profile: "metered",
      prompt: "count my tokens",
      retry: { maxAttempts: 2 },
    });
    const rec = await orch.waitTask(sub.taskId, 10000);
    assert.equal(rec?.status, "succeeded");
    assert.equal(rec?.attempt, 2);

    // Each attempt reports 10 input tokens / 1 USD; the task spent both.
    assert.equal(rec?.usage?.inputTokens, 20);
    assert.equal(rec?.usage?.cost?.amount, 2);
    assert.equal(rec?.usage?.cost?.currency, "USD");
    assert.equal(rec?.usage?.reports, 2);

    const attempts = attemptsOf(rec);
    assert.equal((attempts[0]?.usage as Record<string, unknown> | undefined)?.inputTokens, 10);

    const sum = orch.usageSummary();
    assert.deepEqual(sum.cost, [{ currency: "USD", amount: 2 }]);
  } finally {
    await orch.shutdown();
  }
});

test("admission refusals are never retried, and onlyRetryable skips non-retryable errors", async () => {
  const queued = make({ maxConcurrentTasks: 5, maxQueuedTasks: 5 }, [
    { name: "fast", driver: "mock", mock: fast },
  ]);
  const picky = make({}, [{ name: "flaky", driver: "mock", mock: { delayMs: 1, failOn: "boom" } }]);
  try {
    // A refusal never reached a worker, so replaying it would fail identically.
    const refused = queued.submitTask({
      profile: "fast",
      prompt: "x",
      dependsOn: ["no-such-task"],
      retry: { maxAttempts: 3 },
    });
    assert.equal(refused.status, "failed");
    assert.equal(refused.error?.code, "dependency_unknown_task");
    assert.equal(refused.attempt, 1);
    assert.ok(!queued.taskEvents(refused.taskId).some((e) => e.type === "retry"));

    // A worker error carries `retryable: false`; onlyRetryable must respect it.
    const sub = picky.submitTask({
      profile: "flaky",
      prompt: "go boom",
      retry: { maxAttempts: 3, onlyRetryable: true },
    });
    const rec = await picky.waitTask(sub.taskId, 8000);
    assert.equal(rec?.status, "failed");
    assert.equal(rec?.attempt, 1);
    assert.equal(rec?.error?.code, "MOCK_FAIL");
    assert.ok(!picky.taskEvents(sub.taskId).some((e) => e.type === "retry"));
  } finally {
    await queued.shutdown();
    await picky.shutdown();
  }
});

test("cancelling during the backoff stops the retry before it starts", async () => {
  const orch = make({}, [{ name: "wobbly", driver: "mock", mock: { delayMs: 1, failFirst: 1 } }]);
  try {
    const sub = orch.submitTask({
      profile: "wobbly",
      prompt: "cancel me",
      retry: { maxAttempts: 3, delayMs: 5000 },
    });

    // Wait until the first attempt has failed and the task is queued for a retry.
    let rec: TaskRecord | undefined;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      rec = orch.taskStatus(sub.taskId);
      if (rec?.attempt === 2 && rec.retryAt !== undefined) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(rec?.attempt, 2, "the second attempt is scheduled");
    assert.equal(rec?.status, "queued");

    const cancelled = await orch.cancelTask(sub.taskId);
    assert.equal(cancelled?.status, "cancelled");

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      orch.taskEvents(sub.taskId).filter((e) => e.type === "started").length,
      1,
      "the pending retry must not start after cancellation",
    );
  } finally {
    await orch.shutdown();
  }
});

test("limits.maxRetryAttempts clamps a policy that asks for more", async () => {
  const orch = make({ maxRetryAttempts: 2 }, [
    { name: "flaky", driver: "mock", mock: { delayMs: 1, failOn: "boom" } },
  ]);
  try {
    const sub = orch.submitTask({
      profile: "flaky",
      prompt: "go boom",
      retry: { maxAttempts: 99 },
    });
    const rec = await orch.waitTask(sub.taskId, 8000);
    assert.equal(rec?.status, "failed");
    assert.equal(rec?.maxAttempts, 2);
    assert.equal(rec?.attempt, 2);
  } finally {
    await orch.shutdown();
  }
});

test("dependency and retry fields survive a SQLite round trip", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-dag-"));
  const dbPath = path.join(dir, "tasks.sqlite");
  try {
    const store = new SqliteTaskStore(dbPath);
    const now = Date.now();
    store.createTask({
      taskId: "t1",
      profile: "p",
      prompt: "hello",
      workingDirectory: process.cwd(),
      status: "queued",
      timeoutMs: 1000,
      createdAt: now,
      updatedAt: now,
      dependsOn: ["a", "b"],
      blockedBy: ["b"],
      attempt: 2,
      maxAttempts: 4,
      retryAt: now + 500,
    });
    const back = store.getTask("t1");
    assert.deepEqual(back?.dependsOn, ["a", "b"]);
    assert.deepEqual(back?.blockedBy, ["b"]);
    assert.equal(back?.attempt, 2);
    assert.equal(back?.maxAttempts, 4);
    assert.equal(back?.retryAt, now + 500);

    store.updateTask("t1", { blockedBy: [] });
    assert.deepEqual(store.getTask("t1")?.blockedBy, []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
