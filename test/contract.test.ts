import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { extractJson, MAX_SCHEMA_BYTES } from "../src/contract.js";

/**
 * Structured result contracts + usage roll-up, driven through the public
 * Orchestrator surface against deterministic mock workers.
 */

const SCHEMA = {
  type: "object",
  required: ["title", "count"],
  properties: {
    title: { type: "string" },
    count: { type: "integer", minimum: 1 },
  },
  additionalProperties: false,
};

const OK_SCHEMA = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };

const config = parseConfig({
  workdir: ".agentmesh-test",
  profiles: [
    { name: "json", driver: "mock", mock: { delayMs: 1, toolCalls: 0, reply: '{"title":"t","count":3}' } },
    {
      name: "fenced",
      driver: "mock",
      mock: { delayMs: 1, toolCalls: 0, reply: 'Sure, here it is:\n```json\n{"title":"t","count":3}\n```\nHope that helps.' },
    },
    { name: "prose", driver: "mock", mock: { delayMs: 1, toolCalls: 0, reply: "I reckon about three." } },
    { name: "bad", driver: "mock", mock: { delayMs: 1, toolCalls: 0, reply: '{"title":3}' } },
    {
      name: "metered",
      driver: "mock",
      mock: {
        delayMs: 1,
        toolCalls: 0,
        reply: '{"ok":true}',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          cost: { amount: 0.01, currency: "USD" },
          contextUsed: 1000,
          contextSize: 200000,
          reports: 3,
        },
      },
    },
    {
      name: "yuan",
      driver: "mock",
      mock: {
        delayMs: 1,
        toolCalls: 0,
        reply: '{"ok":true}',
        usage: { cost: { amount: 0.2, currency: "CNY" } },
      },
    },
    // Fails whenever the prompt contains the contract instruction — proves the
    // instruction actually reaches the worker rather than living only in metadata.
    { name: "guarded", driver: "mock", mock: { delayMs: 1, toolCalls: 0, failOn: "OUTPUT CONTRACT" } },
  ],
});

const memOrch = () => new Orchestrator(config, { baseCwd: process.cwd(), persist: false });
const approx = (actual: number | undefined, expected: number) =>
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < 1e-9,
    `expected ≈${expected}, got ${actual}`,
  );

/* --------------------------- parse/extract units -------------------------- */

test("extractJson handles fences, prose padding, and braces inside strings", () => {
  assert.deepEqual(extractJson('{"a":"} not the end"}'), { value: { a: "} not the end" } });
  assert.deepEqual(extractJson('prefix ```json\n[1,2]\n``` suffix'), { value: [1, 2] });
  assert.deepEqual(extractJson('The answer is {"n":1} — done.'), { value: { n: 1 } });
  assert.equal(extractJson("no json at all"), undefined);
  assert.equal(extractJson(""), undefined);
});

/* ------------------------------- contracts ------------------------------- */

test("a conforming JSON reply is parsed into `structured`", async () => {
  const orch = memOrch();
  try {
    const t = orch.submitTask({ profile: "json", prompt: "give me data", outputSchema: SCHEMA });
    const r = await orch.waitTask(t.taskId, 5000);
    assert.equal(r?.status, "succeeded");
    assert.deepEqual(r?.structured, { title: "t", count: 3 });
    assert.equal((r?.metadata?.outputContract as { status?: string })?.status, "ok");
    // The schema is prompt payload, not part of the accepted task text.
    assert.equal(r?.prompt, "give me data");
    assert.ok(!r?.prompt.includes("json-schema"));
  } finally {
    await orch.shutdown();
  }
});

test("JSON wrapped in prose and a code fence is still accepted", async () => {
  const orch = memOrch();
  try {
    const t = orch.submitTask({ profile: "fenced", prompt: "give me data", outputSchema: SCHEMA });
    const r = await orch.waitTask(t.taskId, 5000);
    assert.equal(r?.status, "succeeded");
    assert.deepEqual(r?.structured, { title: "t", count: 3 });
  } finally {
    await orch.shutdown();
  }
});

test("an unparseable reply fails `output_not_json` and keeps the text", async () => {
  const orch = memOrch();
  try {
    const t = orch.submitTask({ profile: "prose", prompt: "give me data", outputSchema: SCHEMA });
    const r = await orch.waitTask(t.taskId, 5000);
    assert.equal(r?.status, "failed");
    assert.equal(r?.error?.code, "output_not_json");
    assert.equal(r?.error?.retryable, true);
    // The offending answer is kept, otherwise the failure is undiagnosable.
    assert.match(r?.text ?? "", /three/);
    assert.equal(r?.structured, undefined);
    const c = r?.metadata?.outputContract as { status?: string } | undefined;
    assert.equal(c?.status, "violated");
  } finally {
    await orch.shutdown();
  }
});

test("valid JSON that violates the schema fails with the offending paths", async () => {
  const orch = memOrch();
  try {
    const t = orch.submitTask({ profile: "bad", prompt: "give me data", outputSchema: SCHEMA });
    const r = await orch.waitTask(t.taskId, 5000);
    assert.equal(r?.status, "failed");
    assert.equal(r?.error?.code, "output_schema_invalid");
    const c = r?.metadata?.outputContract as {
      status?: string;
      errors?: Array<{ path: string; message: string }>;
    };
    assert.equal(c.status, "violated");
    assert.ok((c.errors?.length ?? 0) >= 2, `expected both missing and wrong-typed fields, got ${c.errors?.length}`);
    // `count` is missing and `title` is the wrong type: both must be named.
    assert.ok(c.errors?.some((e) => e.path === "/title"));
  } finally {
    await orch.shutdown();
  }
});

test("the contract instruction reaches the worker; without a schema it does not", async () => {
  const orch = memOrch();
  try {
    const withSchema = orch.submitTask({ profile: "guarded", prompt: "x", outputSchema: SCHEMA });
    const r1 = await orch.waitTask(withSchema.taskId, 5000);
    assert.equal(r1?.status, "failed");
    assert.equal(r1?.error?.code, "MOCK_FAIL");

    const control = orch.submitTask({ profile: "guarded", prompt: "x" });
    const r2 = await orch.waitTask(control.taskId, 5000);
    assert.equal(r2?.status, "succeeded");
  } finally {
    await orch.shutdown();
  }
});

test("an oversized schema is refused before a worker is spawned", async () => {
  const orch = memOrch();
  try {
    const huge = { type: "object", description: "x".repeat(MAX_SCHEMA_BYTES + 100) };
    const r = orch.submitTask({ profile: "json", prompt: "x", outputSchema: huge });
    assert.equal(r.status, "failed");
    assert.equal(r.error?.code, "output_schema_too_large");
    assert.equal(orch.listWorkers().length, 0);
  } finally {
    await orch.shutdown();
  }
});

/* --------------------------------- usage --------------------------------- */

test("usage keeps the latest report rather than summing the running totals", async () => {
  const orch = memOrch();
  try {
    const t = orch.submitTask({ profile: "metered", prompt: "x", outputSchema: OK_SCHEMA });
    const r = await orch.waitTask(t.taskId, 5000);
    assert.equal(r?.status, "succeeded");
    assert.equal(r?.usage?.inputTokens, 300); // 3 reports × 100, not 100+200+300
    assert.equal(r?.usage?.outputTokens, 150);
    assert.equal(r?.usage?.totalTokens, 450);
    assert.equal(r?.usage?.reports, 3);
    assert.equal(r?.usage?.contextUsed, 1000);
    assert.equal(r?.usage?.contextSize, 200000);
    approx(r?.usage?.cost?.amount, 0.03);
    assert.equal(r?.usage?.cost?.currency, "USD");
  } finally {
    await orch.shutdown();
  }
});

test("cost on a reused worker is a delta, not the session total", async () => {
  const orch = memOrch();
  try {
    const first = orch.submitTask({ profile: "metered", prompt: "x", outputSchema: OK_SCHEMA });
    const r1 = await orch.waitTask(first.taskId, 5000);
    approx(r1?.usage?.cost?.amount, 0.03);

    const second = orch.submitTask({
      profile: "metered",
      workerId: r1?.workerId,
      prompt: "y",
      outputSchema: OK_SCHEMA,
    });
    const r2 = await orch.waitTask(second.taskId, 5000);
    // The worker's cumulative counter is now 0.06; this task spent 0.03 of it.
    approx(r2?.usage?.cost?.amount, 0.03);
  } finally {
    await orch.shutdown();
  }
});

test("usage_summary aggregates tokens, groups cost by currency, and filters by profile", async () => {
  const orch = memOrch();
  try {
    const a = orch.submitTask({ profile: "metered", prompt: "x", outputSchema: OK_SCHEMA });
    const b = orch.submitTask({ profile: "yuan", prompt: "y", outputSchema: OK_SCHEMA });
    await orch.waitTask(a.taskId, 5000);
    await orch.waitTask(b.taskId, 5000);

    const all = orch.usageSummary();
    assert.equal(all.tasks, 2);
    assert.equal(all.reporting, 2);
    assert.equal(all.inputTokens, 300);
    assert.equal(all.totalTokens, 450);
    assert.equal(all.cost.length, 2, "USD and CNY must stay separate");
    assert.equal(all.cost[0]?.currency, "CNY");
    approx(all.cost[0]?.amount, 0.2);
    assert.equal(all.cost[1]?.currency, "USD");
    approx(all.cost[1]?.amount, 0.03);

    const onlyYuan = orch.usageSummary({ profile: "yuan" });
    assert.equal(onlyYuan.tasks, 1);
    assert.equal(onlyYuan.cost.length, 1);
    approx(onlyYuan.cost[0]?.amount, 0.2);

    // A cutoff after both tasks excludes them entirely.
    const none = orch.usageSummary({ since: Date.now() + 60_000 });
    assert.equal(none.tasks, 0);
    assert.equal(none.cost.length, 0);
  } finally {
    await orch.shutdown();
  }
});
