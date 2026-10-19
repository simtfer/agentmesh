import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";

const config = parseConfig({
  profiles: [
    { name: "analyst", driver: "mock", mock: { delayMs: 1, toolCalls: 2 } },
    { name: "worker", driver: "mock", mock: { delayMs: 1 } },
    { name: "flaky", driver: "mock", mock: { delayMs: 1, failOn: "boom" } },
  ],
});

test("dispatch spawns a worker and completes the delegation loop", async () => {
  const orch = new Orchestrator(config);
  const res = await orch.dispatch({ profile: "analyst", task: "inspect the repo layout" });
  assert.equal(res.status, "completed");
  assert.equal(res.profile, "analyst");
  assert.match(res.text, /analyst/);
  assert.ok(res.workerId.length > 0);
  await orch.shutdown();
});

test("a spawned worker can be reused for follow-ups via workerId", async () => {
  const orch = new Orchestrator(config);
  const id = await orch.spawnWorker("worker");
  const r1 = await orch.dispatch({ workerId: id, task: "step one" });
  const r2 = await orch.dispatch({ workerId: id, task: "step two" });
  assert.equal(r1.workerId, id);
  assert.equal(r2.workerId, id);
  assert.equal(orch.listWorkers().length, 1);
  await orch.shutdown();
});

test("events are captured and surfaced as task output events", async () => {
  const orch = new Orchestrator(config);
  const seen: string[] = [];
  const taskEvents: string[] = [];
  await orch.dispatch({
    profile: "analyst",
    task: "trace it",
    onEvent: (ev) => {
      taskEvents.push(ev.type);
      if (ev.type === "output") seen.push(String(ev.data?.kind));
    },
  });
  // worker-level events surface as `output` task events carrying the original kind
  assert.ok(seen.includes("tool"));
  assert.ok(seen.includes("text"));
  assert.ok(seen.includes("done"));
  // lifecycle task events are emitted too
  assert.ok(taskEvents.includes("accepted"));
  assert.ok(taskEvents.includes("completed"));
  await orch.shutdown();
});

test("a failing worker reports failed status and error", async () => {
  const orch = new Orchestrator(config);
  const res = await orch.dispatch({ profile: "flaky", task: "go boom now" });
  assert.equal(res.status, "failed");
  assert.equal(res.error?.code, "MOCK_FAIL");
  await orch.shutdown();
});

test("kill_worker removes it from the registry", async () => {
  const orch = new Orchestrator(config);
  const id = await orch.spawnWorker("worker");
  assert.equal(orch.listWorkers().length, 1);
  await orch.killWorker(id);
  assert.equal(orch.listWorkers().length, 0);
  await orch.shutdown();
});

test("listProfiles reflects config", async () => {
  const orch = new Orchestrator(config);
  const names = orch.listProfiles().map((p) => p.name);
  assert.deepEqual(names, ["analyst", "worker", "flaky"]);
  await orch.shutdown();
});

/* ------------------------- pinned sessions ------------------------- */

test("spawning under the same sessionKey attaches to the live worker", async () => {
  const orch = new Orchestrator(config);
  const first = await orch.spawnWorker("worker", { sessionKey: "main" });
  const again = await orch.spawnWorker("worker", { sessionKey: "main" });
  assert.equal(again, first, "a pinned key must not start a second worker on the same session");
  assert.equal(orch.listWorkers().length, 1);
  assert.equal(orch.getWorker(first)?.sessionKey, "main");
  await orch.shutdown();
});

test("different sessionKeys are different conversations", async () => {
  const orch = new Orchestrator(config);
  const a = await orch.spawnWorker("worker", { sessionKey: "a" });
  const b = await orch.spawnWorker("worker", { sessionKey: "b" });
  assert.notEqual(a, b);
  assert.equal(orch.listWorkers().length, 2);
  await orch.shutdown();
});

test("a profile-pinned session applies without a per-spawn key", async () => {
  const cfg = parseConfig({
    profiles: [{ name: "pinned", driver: "mock", session: "long-lived" }],
  });
  const orch = new Orchestrator(cfg);
  const id = await orch.spawnWorker("pinned");
  assert.equal(orch.getWorker(id)?.sessionKey, "long-lived");
  await orch.shutdown();
});

test("a pinned session refuses worktree isolation", async () => {
  // A fresh worktree path every spawn would never match the stored session, so
  // the conversation would silently restart — refuse rather than pretend.
  const orch = new Orchestrator(config);
  await assert.rejects(
    () => orch.spawnWorker("worker", { sessionKey: "main", worktree: true }),
    /cannot be combined with worktree/,
  );
  assert.equal(orch.listWorkers().length, 0);
  await orch.shutdown();
});

test("attaching to a session that is mid-turn is refused, not queued", async () => {
  const cfg = parseConfig({
    profiles: [{ name: "slow", driver: "mock", mock: { delayMs: 300 } }],
  });
  const orch = new Orchestrator(cfg);
  const running = orch.dispatch({ profile: "slow", sessionKey: "main", task: "long one" });
  // Wait for the worker to actually be bound and busy.
  while (!orch.listTasks({ status: "running" }).length) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await assert.rejects(
    () => orch.spawnWorker("slow", { sessionKey: "main" }),
    /is busy/,
  );
  assert.equal((await running).status, "completed");
  await orch.shutdown();
});
