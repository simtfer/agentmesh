/**
 * Approval and spend budgets: the two guards that bound what a fan-out can cost
 * *while it runs*.
 *
 * Both are deliberately opt-in, so every case here sets the knob it exercises
 * and asserts the public record (status, error code, events, `usage_summary`)
 * rather than manager internals. The mock driver reports usage as cumulative
 * totals, which is what makes "did it count this twice?" observable at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";

/**
 * One orchestrator per test, rooted in a throwaway directory: `persist: false`
 * skips SQLite, but the orchestrator still creates its workdir, and a suite must
 * not leave directories behind in the repo.
 */
function harness(limits: unknown, profiles: unknown[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-budget-"));
  const orch = new Orchestrator(parseConfig({ workdir: dir, limits, profiles }), {
    baseCwd: dir,
    persist: false,
  });
  return {
    orch,
    cleanup: async () => {
      await orch.shutdown().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const budgetMeta = (rec: { metadata?: Record<string, unknown> } | undefined): any =>
  rec?.metadata?.budget;

const eventKinds = (orch: Orchestrator, taskId: string): string[] =>
  orch
    .taskEvents(taskId)
    .filter((e) => e.type === "budget")
    .map((e) => String((e.data as Record<string, unknown> | undefined)?.kind ?? ""));

/* --------------------------- approval width ---------------------------- */

test("past the waiting cap a permission request is refused, not parked", async () => {
  const { orch, cleanup } = harness({ maxConcurrentTasks: 2, maxWaitingTasks: 1 }, [
    { name: "asker", driver: "mock", mock: { delayMs: 1, requireApproval: true } },
  ]);
  try {
    const first = orch.submitTask({ profile: "asker", prompt: "one" });
    const r1 = await orch.waitTask(first.taskId, 5000);
    assert.equal(r1?.status, "waiting", "the first task parks on its approval");
    assert.equal(orch.pendingApprovals().length, 1);

    // The budget is now full: this one must be told "no" instead of queueing up
    // behind a question the master has not answered.
    const second = orch.submitTask({ profile: "asker", prompt: "two" });
    const r2 = await orch.waitTask(second.taskId, 5000);
    assert.equal(r2?.status, "failed", "the worker sees a plain denial");
    assert.equal(r2?.error?.code, "REJECTED");

    assert.deepEqual(eventKinds(orch, second.taskId), ["approval_budget"]);
    assert.ok(
      !orch.taskEvents(second.taskId).some((e) => e.type === "waiting"),
      "the refused task never entered `waiting`",
    );
    assert.equal(orch.pendingApprovals().length, 1, "still exactly one parked task");

    // Answering the first one still works normally.
    const pending = orch.pendingApprovals();
    assert.ok(orch.approveTask(pending[0]!.id, "allow_once"));
    const done = await orch.waitTask(first.taskId, 5000);
    assert.equal(done?.status, "succeeded");
  } finally {
    await cleanup();
  }
});

test("without a cap every request parks, exactly as before", async () => {
  const { orch, cleanup } = harness({ maxConcurrentTasks: 2 }, [
    { name: "asker", driver: "mock", mock: { delayMs: 1, requireApproval: true } },
  ]);
  try {
    const a = orch.submitTask({ profile: "asker", prompt: "one" });
    const b = orch.submitTask({ profile: "asker", prompt: "two" });
    const [ra, rb] = await Promise.all([
      orch.waitTask(a.taskId, 5000),
      orch.waitTask(b.taskId, 5000),
    ]);
    assert.equal(ra?.status, "waiting");
    assert.equal(rb?.status, "waiting");
    assert.equal(orch.pendingApprovals().length, 2);
  } finally {
    await cleanup();
  }
});

/* ----------------------------- task budget ----------------------------- */

test("a task over its token ceiling is stopped and settles budget_exceeded", async () => {
  const { orch, cleanup } = harness({}, [
    { name: "spendy", driver: "mock", mock: { delayMs: 1, usage: { totalTokens: 1000 } } },
  ]);
  try {
    const t = orch.submitTask({
      profile: "spendy",
      prompt: "burn tokens",
      budget: { maxTokens: 100 },
    });
    const rec = await orch.waitTask(t.taskId, 5000);

    assert.equal(rec?.status, "failed", "overspending fails the task, it does not just warn");
    assert.equal(rec?.error?.code, "budget_exceeded");
    assert.equal(rec?.error?.retryable, false, "replaying it would spend again");

    const meta = budgetMeta(rec);
    assert.equal(meta?.exceeded, true);
    assert.equal(meta?.totalTokens, 1000, "the record says what it actually spent");
    assert.equal(rec?.usage?.totalTokens, 1000, "the spend is still reported");

    assert.ok(
      orch.taskEvents(t.taskId).some((e) => e.type === "budget"),
      "the breach is on the task's timeline",
    );
  } finally {
    await cleanup();
  }
});

test("a task within its ceiling is untouched", async () => {
  const { orch, cleanup } = harness({}, [
    { name: "frugal", driver: "mock", mock: { delayMs: 1, usage: { totalTokens: 10 } } },
  ]);
  try {
    const t = orch.submitTask({
      profile: "frugal",
      prompt: "stay small",
      budget: { maxTokens: 100 },
    });
    const rec = await orch.waitTask(t.taskId, 5000);
    assert.equal(rec?.status, "succeeded");
    assert.equal(budgetMeta(rec), undefined, "no breach, no budget record");
  } finally {
    await cleanup();
  }
});

test("a cost ceiling applies in the currency it was written in", async () => {
  const { orch, cleanup } = harness({}, [
    {
      name: "costly",
      driver: "mock",
      mock: { delayMs: 1, usage: { totalTokens: 1, cost: { amount: 0.5, currency: "USD" } } },
    },
  ]);
  try {
    const t = orch.submitTask({
      profile: "costly",
      prompt: "spend money",
      budget: { maxCost: { amount: 0.2, currency: "USD" } },
    });
    const rec = await orch.waitTask(t.taskId, 5000);
    assert.equal(rec?.status, "failed");
    assert.equal(rec?.error?.code, "budget_exceeded");
    assert.equal(budgetMeta(rec)?.cost?.amount, 0.5);
  } finally {
    await cleanup();
  }
});

test("a cost ceiling in another currency cannot be applied, and says so once", async () => {
  const { orch, cleanup } = harness({}, [
    {
      name: "costly",
      driver: "mock",
      mock: { delayMs: 1, usage: { totalTokens: 1, cost: { amount: 5, currency: "USD" } } },
    },
  ]);
  try {
    const t = orch.submitTask({
      profile: "costly",
      prompt: "spend money",
      budget: { maxCost: { amount: 0.1, currency: "CNY" } },
    });
    const rec = await orch.waitTask(t.taskId, 5000);

    // Failing the task would be wrong (the numbers are not comparable) and
    // silently ignoring the ceiling would be worse, so it runs and warns.
    assert.equal(rec?.status, "succeeded");
    assert.deepEqual(eventKinds(orch, t.taskId), ["budget_currency_mismatch"]);
  } finally {
    await cleanup();
  }
});

test("a retry shares one allowance instead of getting a fresh one", async () => {
  const { orch, cleanup } = harness({}, [
    {
      name: "flaky",
      driver: "mock",
      // 30 tokens per attempt, and the first attempt dies after spending them.
      mock: { delayMs: 1, failFirst: 1, usage: { totalTokens: 30 } },
    },
  ]);
  try {
    const t = orch.submitTask({
      profile: "flaky",
      prompt: "try twice",
      retry: { maxAttempts: 2, delayMs: 0 },
      budget: { maxTokens: 40 },
    });
    const rec = await orch.waitTask(t.taskId, 6000);

    assert.equal(rec?.status, "failed");
    assert.equal(rec?.error?.code, "budget_exceeded");
    assert.equal(
      rec?.usage?.totalTokens,
      60,
      "the second attempt's spend is added to the first's, not measured alone",
    );
    const attempts = rec?.metadata?.attempts as unknown[] | undefined;
    assert.equal(attempts?.length, 1, "the first attempt was archived and the second settled");
  } finally {
    await cleanup();
  }
});

test("an overspending task is not retried even when the policy allows it", async () => {
  const { orch, cleanup } = harness({}, [
    { name: "spendy", driver: "mock", mock: { delayMs: 1, usage: { totalTokens: 1000 } } },
  ]);
  try {
    const t = orch.submitTask({
      profile: "spendy",
      prompt: "burn",
      retry: { maxAttempts: 3, delayMs: 0 },
      budget: { maxTokens: 10 },
    });
    const rec = await orch.waitTask(t.taskId, 5000);
    assert.equal(rec?.status, "failed");
    assert.equal(rec?.error?.code, "budget_exceeded");
    assert.equal(rec?.attempt, 1, "it never started a second attempt");
    assert.equal(rec?.metadata?.attempts, undefined);
  } finally {
    await cleanup();
  }
});

/* ---------------------------- session budget --------------------------- */

test("once the process token ceiling is reached, new submits are refused", async () => {
  const { orch, cleanup } = harness({ maxTotalTokens: 50 }, [
    { name: "spendy", driver: "mock", mock: { delayMs: 1, usage: { totalTokens: 100 } } },
  ]);
  try {
    const first = orch.submitTask({ profile: "spendy", prompt: "spend it all" });
    const done = await orch.waitTask(first.taskId, 5000);
    assert.equal(done?.status, "succeeded", "accepted work is left alone");

    const second = orch.submitTask({ profile: "spendy", prompt: "one more" });
    assert.equal(second.status, "failed", "submit is synchronous, so the refusal is immediate");
    assert.equal(second.error?.code, "budget_exhausted");
    assert.match(second.error?.message ?? "", /maxTotalTokens/);
    assert.equal(orch.schedulerStatus().running, 0, "no worker was spawned for it");
  } finally {
    await cleanup();
  }
});

test("usage_summary reports headroom, not just a post-hoc total", async () => {
  const { orch, cleanup } = harness({ maxTotalTokens: 50 }, [
    { name: "spendy", driver: "mock", mock: { delayMs: 1, usage: { totalTokens: 100 } } },
  ]);
  try {
    const before = orch.usageSummary();
    assert.equal(before.budget.exhausted, false);
    assert.equal(before.budget.spentTokens, 0);
    assert.equal(before.budget.maxTotalTokens, 50);

    const t = orch.submitTask({ profile: "spendy", prompt: "spend" });
    await orch.waitTask(t.taskId, 5000);

    const after = orch.usageSummary();
    assert.equal(after.budget.spentTokens, 100);
    assert.equal(after.budget.exhausted, true);
    assert.match(after.budget.reason ?? "", /100 tokens/);
  } finally {
    await cleanup();
  }
});

test("a cost ceiling is bucketed by currency, so another currency cannot trip it", async () => {
  const { orch, cleanup } = harness({ maxTotalCost: { amount: 0.1, currency: "CNY" } }, [
    {
      name: "usd",
      driver: "mock",
      mock: { delayMs: 1, usage: { totalTokens: 1, cost: { amount: 10, currency: "USD" } } },
    },
  ]);
  try {
    const t = orch.submitTask({ profile: "usd", prompt: "spend dollars" });
    await orch.waitTask(t.taskId, 5000);

    const summary = orch.usageSummary();
    assert.equal(summary.budget.exhausted, false, "10 USD says nothing about a 0.1 CNY ceiling");
    assert.deepEqual(summary.budget.spentCost, [{ currency: "USD", amount: 10 }]);

    const next = orch.submitTask({ profile: "usd", prompt: "and again" });
    assert.notEqual(next.error?.code, "budget_exhausted", "work is still admitted");
    const done = await orch.waitTask(next.taskId, 5000);
    assert.equal(done?.status, "succeeded");
  } finally {
    await cleanup();
  }
});
