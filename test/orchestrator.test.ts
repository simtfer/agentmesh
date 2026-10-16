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
