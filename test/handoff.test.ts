import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { redactSecrets } from "../src/handoff.js";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, windowsHide: true, stdio: "pipe" }).toString();

/** A throwaway repo with one committed file, so worktrees have something to hold. */
function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-handoff-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

const LEAKY = [
  "feature: add health check",
  "aws_key = AKIAIOSFODNN7EXAMPLE",
  'password = "sup3rs3cr3tpassword"',
  "notes",
].join("\n");

const config = parseConfig({
  profiles: [
    // writes a file containing secret-shaped strings, in an isolated worktree
    {
      name: "writer",
      driver: "mock",
      worktree: true,
      mock: { delayMs: 1, writeFiles: { "src/feature.ts": LEAKY } },
    },
    // writes nothing — used for successors/controls
    { name: "inspector", driver: "mock", worktree: true, mock: { delayMs: 1 } },
    // no worktree at all
    { name: "plain", driver: "mock", mock: { delayMs: 1 } },
    // a remote successor: never contacted, because artifact handoffs are refused
    { name: "remote-worker", driver: "remote", remote: { endpoint: "http://127.0.0.1:9" } },
  ],
});

interface Ctx {
  repo: string;
  workdir: string;
  orch: Orchestrator;
}

function setup(): Ctx {
  const repo = makeRepo();
  const state = mkdtempSync(path.join(tmpdir(), "agentmesh-state-"));
  const workdir = path.join(state, "state");
  const orch = new Orchestrator(config, { baseCwd: repo, workdir, persist: false });
  return { repo, workdir, orch };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.orch.shutdown();
  rmSync(path.dirname(ctx.workdir), { recursive: true, force: true });
  rmSync(ctx.repo, { recursive: true, force: true });
}

/** Run a task to completion and return its final record. */
async function run(orch: Orchestrator, input: Parameters<Orchestrator["submitTask"]>[0]) {
  const sub = orch.submitTask(input);
  const rec = await orch.waitTask(sub.taskId, 20000);
  assert.ok(rec, "task should settle");
  return rec!;
}

/* ------------------------------------------------------------------ */
/* redaction unit tests                                                */
/* ------------------------------------------------------------------ */

test("redactSecrets replaces known secret shapes and counts them", () => {
  const input = [
    "AKIAIOSFODNN7EXAMPLE",
    "ghp_1234567890abcdefghijABCDEFGHIJ1234",
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
    "xoxb-1234567890-abcdefghij",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    'password = "sup3rs3cr3t"',
  ].join("\n");

  const { text, report } = redactSecrets(input);

  assert.doesNotMatch(text, /AKIAIOSFODNN7EXAMPLE/);
  assert.doesNotMatch(text, /ghp_1234567890/);
  assert.doesNotMatch(text, /sk-ant-api03/);
  assert.doesNotMatch(text, /xoxb-1234567890/);
  assert.doesNotMatch(text, /abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(text, /sup3rs3cr3t/);
  assert.ok(report.total >= 6, `expected >=6 redactions, got ${report.total}`);
  assert.ok((report.counts["aws-access-key"] ?? 0) >= 1);
  assert.ok((report.counts["private-key"] ?? 0) === 0);
});

test("redactSecrets removes a whole PEM private key block", () => {
  const pem = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEA1234567890abcdefghijklmnop",
    "qrstuvwxyz0987654321",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const { text, report } = redactSecrets(`before\n${pem}\nafter`);
  assert.doesNotMatch(text, /MIIEowIBAAKCAQEA/);
  assert.equal(report.counts["private-key"], 1);
  assert.match(text, /before\n\[REDACTED:private-key\]\nafter/);
});

test("redactSecrets keeps the key name and separator when redacting an assignment", () => {
  const { text } = redactSecrets('+api_key = "abcdefgh12345678"');
  assert.match(text, /api_key = "\[REDACTED:assignment\]"/);
});

test("redactSecrets leaves ordinary code alone", () => {
  const code = [
    "const tokenize = (s: string) => s.split(' ');",
    "if (token === undefined) return;",
    "secretary: a person",
    "timeoutMs: 30000",
  ].join("\n");
  const { text, report } = redactSecrets(code);
  assert.equal(text, code);
  assert.equal(report.total, 0);
});

/* ------------------------------------------------------------------ */
/* Phase 2: inject: "diff"                                             */
/* ------------------------------------------------------------------ */

test("a diff handoff writes a redacted sidecar and points the successor at it", async () => {
  const ctx = setup();
  try {
    const pred = await run(ctx.orch, { profile: "writer", prompt: "add the feature" });
    assert.equal(pred.status, "succeeded");

    const succ = await run(ctx.orch, {
      profile: "inspector",
      prompt: "review the patch",
      handoff: { fromTaskId: pred.taskId, inject: "diff" },
    });
    assert.equal(succ.status, "succeeded");

    const ho = succ.metadata?.handoff as Record<string, unknown>;
    assert.equal(ho.inject, "diff");
    assert.ok((ho.filesChanged as number) >= 1);
    assert.ok((ho.redactions as number) >= 2, `expected >=2 redactions, got ${ho.redactions}`);

    const artifact = path.join(ctx.workdir, String(ho.artifact));
    assert.ok(existsSync(artifact), `sidecar should exist at ${artifact}`);
    const patch = readFileSync(artifact, "utf8");
    assert.match(patch, /src\/feature\.ts/);
    assert.match(patch, /REDACTED:aws-access-key/);
    assert.match(patch, /REDACTED:assignment/);
    assert.doesNotMatch(patch, /AKIAIOSFODNN7EXAMPLE/);
    assert.doesNotMatch(patch, /sup3rs3cr3tpassword/);

    // The worker really was pointed at the file, and the stored prompt is original.
    const prompt = ctx.orch.taskStatus(succ.taskId)!.prompt;
    assert.equal(prompt, "review the patch");
    assert.doesNotMatch(prompt, /Redacted patch/);

    const events = ctx.orch.taskEvents(succ.taskId);
    const hoEvent = events.find((e) => e.type === "handoff");
    assert.ok(hoEvent, "a handoff event should be recorded");
    assert.equal((hoEvent!.data as Record<string, unknown>).inject, "diff");
  } finally {
    await teardown(ctx);
  }
});

test("a diff handoff with no changes succeeds and says so", async () => {
  const ctx = setup();
  try {
    const pred = await run(ctx.orch, { profile: "inspector", prompt: "look around" });
    const succ = await run(ctx.orch, {
      profile: "inspector",
      prompt: "continue",
      handoff: { fromTaskId: pred.taskId, inject: "diff" },
    });
    assert.equal(succ.status, "succeeded");
    const ho = succ.metadata?.handoff as Record<string, unknown>;
    assert.equal(ho.filesChanged, 0);
    assert.equal(ho.artifact, undefined);
    const ev = ctx.orch.taskEvents(succ.taskId).find((e) => e.type === "handoff");
    assert.match(String(ev?.text), /no working-tree changes/);
  } finally {
    await teardown(ctx);
  }
});

test("a diff handoff honours maxBytes and flags the truncation", async () => {
  const ctx = setup();
  try {
    const pred = await run(ctx.orch, { profile: "writer", prompt: "add the feature" });
    const succ = await run(ctx.orch, {
      profile: "inspector",
      prompt: "review",
      handoff: { fromTaskId: pred.taskId, inject: "diff", maxBytes: 40 },
    });
    const ho = succ.metadata?.handoff as Record<string, unknown>;
    assert.equal(ho.truncated, true);
    assert.ok((ho.injectedBytes as number) <= 40);
    const artifact = path.join(ctx.workdir, String(ho.artifact));
    assert.ok(statSync(artifact).size <= 40);
  } finally {
    await teardown(ctx);
  }
});

/* ------------------------------------------------------------------ */
/* Phase 3: base: "predecessor"                                        */
/* ------------------------------------------------------------------ */

test("base 'predecessor' starts the successor from the predecessor's end state", async () => {
  const ctx = setup();
  try {
    const pred = await run(ctx.orch, { profile: "writer", prompt: "add the feature" });
    assert.equal(pred.status, "succeeded");
    const predDir = ctx.orch.taskStatus(pred.taskId)!.workingDirectory;
    const predHeadBefore = git(predDir, "rev-list", "--count", "HEAD").trim();

    const succ = await run(ctx.orch, {
      profile: "inspector",
      prompt: "finish it",
      handoff: { fromTaskId: pred.taskId, base: "predecessor" },
    });
    assert.equal(succ.status, "succeeded", `expected success, got ${succ.error?.message}`);

    // The successor's own worktree contains the predecessor's uncommitted file…
    const succDir = ctx.orch.taskStatus(succ.taskId)!.workingDirectory;
    assert.notEqual(succDir, predDir, "successor runs in its own worktree");
    const inherited = path.join(succDir, "src", "feature.ts");
    assert.ok(existsSync(inherited), "successor should inherit the predecessor's file");
    assert.match(readFileSync(inherited, "utf8"), /add health check/);

    // …while the predecessor's checkout is untouched: no extra commit, still dirty.
    assert.equal(git(predDir, "rev-list", "--count", "HEAD").trim(), predHeadBefore);
    assert.match(git(predDir, "status", "--porcelain"), /src\//);
  } finally {
    await teardown(ctx);
  }
});

test("base 'repo' does NOT inherit the predecessor's uncommitted files", async () => {
  const ctx = setup();
  try {
    const pred = await run(ctx.orch, { profile: "writer", prompt: "add the feature" });
    const succ = await run(ctx.orch, {
      profile: "inspector",
      prompt: "start clean",
      handoff: { fromTaskId: pred.taskId, base: "repo" },
    });
    assert.equal(succ.status, "succeeded");
    const succDir = ctx.orch.taskStatus(succ.taskId)!.workingDirectory;
    assert.equal(existsSync(path.join(succDir, "src", "feature.ts")), false);
  } finally {
    await teardown(ctx);
  }
});

test("base 'predecessor' is refused without a worktree", async () => {
  const ctx = setup();
  try {
    const pred = await run(ctx.orch, { profile: "plain", prompt: "do something" });
    const succ = await run(ctx.orch, {
      profile: "plain",
      prompt: "continue",
      handoff: { fromTaskId: pred.taskId, base: "predecessor" },
    });
    assert.equal(succ.status, "failed");
    assert.equal(succ.error?.code, "handoff_base_requires_worktree");
    // refused at admission: only the predecessor's worker was ever spawned
    assert.equal(ctx.orch.listWorkers().length, 1);
  } finally {
    await teardown(ctx);
  }
});

test("base 'predecessor' fails cleanly when the predecessor's checkout is gone", async () => {
  const ctx = setup();
  try {
    const pred = await run(ctx.orch, { profile: "writer", prompt: "add the feature" });
    const workerId = pred.workerId!;
    await ctx.orch.killWorker(workerId); // removes the worktree from disk

    const succ = await run(ctx.orch, {
      profile: "inspector",
      prompt: "continue",
      handoff: { fromTaskId: pred.taskId, base: "predecessor" },
    });
    assert.equal(succ.status, "failed");
    assert.equal(succ.error?.code, "handoff_base_unavailable");
  } finally {
    await teardown(ctx);
  }
});

/* ------------------------------------------------------------------ */
/* remote successors                                                   */
/* ------------------------------------------------------------------ */

test("artifact handoffs are refused for a remote successor", async () => {
  const ctx = setup();
  try {
    const pred = await run(ctx.orch, { profile: "writer", prompt: "add the feature" });

    const diffSucc = await run(ctx.orch, {
      profile: "remote-worker",
      prompt: "review",
      handoff: { fromTaskId: pred.taskId, inject: "diff" },
    });
    assert.equal(diffSucc.status, "failed");
    assert.equal(diffSucc.error?.code, "handoff_artifact_unavailable");

    const baseSucc = await run(ctx.orch, {
      profile: "remote-worker",
      prompt: "continue",
      handoff: { fromTaskId: pred.taskId, base: "predecessor" },
    });
    assert.equal(baseSucc.status, "failed");
    assert.equal(baseSucc.error?.code, "handoff_artifact_unavailable");
  } finally {
    await teardown(ctx);
  }
});
