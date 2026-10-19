/**
 * Cross-host handoff artifacts (Stage 8): a diff produced on the master travels
 * with the submit, is staged by the daemon in its own state dir, and the
 * `{{artifact:N}}` token in the prompt is rewritten to a path that exists on the
 * worker's host.
 *
 * The unit cases pin the receiver's validation (a daemon must never write
 * outside its handoff dir, and must not trust a size or a checksum it was
 * handed); the end-to-end case proves the feature, not just the guards.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { WorkerDaemon } from "../src/remote/daemon.js";
import { NoopAuditLog } from "../src/remote/audit.js";
import { SecurityError, stageArtifacts } from "../src/remote/security.js";

const tokenEnv = "AGENTMESH_ARTIFACT_TOKEN";
process.env[tokenEnv] = "artifact-test-token";

const BIG = "y".repeat(4.2 * 1024 * 1024);

const LEAKY = [
  "feature: add health check",
  "aws_key = AKIAIOSFODNN7EXAMPLE",
  "notes",
].join("\n");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, windowsHide: true, stdio: "pipe" }).toString();

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-artifact-repo-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

const daemonConfig = parseConfig({
  workdir: ".unused",
  profiles: [{ name: "sink", driver: "mock", mock: { delayMs: 1 } }],
});

interface Ctx {
  state: string;
  repo: string;
  masterWorkdir: string;
  daemonWorkdir: string;
  master: Orchestrator;
  daemon: Orchestrator;
  server: WorkerDaemon;
  stop: () => Promise<void>;
}

async function setup(): Promise<Ctx> {
  const state = mkdtempSync(path.join(tmpdir(), "agentmesh-artifact-"));
  const repo = makeRepo();
  const masterWorkdir = path.join(state, "master");
  const daemonWorkdir = path.join(state, "daemon");

  const daemon = new Orchestrator(daemonConfig, {
    baseCwd: repo,
    workdir: daemonWorkdir,
    persist: false,
  });
  const server = new WorkerDaemon({
    config: daemonConfig,
    orchestrator: daemon,
    host: "127.0.0.1",
    port: 0,
    token: process.env[tokenEnv]!,
    allowCwd: [repo],
    audit: new NoopAuditLog(),
  });
  const info = await server.start();

  const config = parseConfig({
    workdir: ".unused",
    profiles: [
      { name: "writer", driver: "mock", worktree: true, mock: { delayMs: 1, writeFiles: { "src/feature.ts": LEAKY } } },
      { name: "big-writer", driver: "mock", worktree: true, mock: { delayMs: 1, writeFiles: { "big.txt": BIG } } },
      {
        name: "remote-sink",
        driver: "remote",
        remote: { endpoint: info.url, tokenEnv, remoteProfile: "sink" },
      },
    ],
  });
  const master = new Orchestrator(config, { baseCwd: repo, workdir: masterWorkdir, persist: false });

  return {
    state,
    repo,
    masterWorkdir,
    daemonWorkdir,
    master,
    daemon,
    server,
    stop: async () => {
      await server.stop().catch(() => {});
      await master.shutdown().catch(() => {});
      await daemon.shutdown().catch(() => {});
      rmSync(state, { recursive: true, force: true });
    },
  };
}

async function submit(
  orch: Orchestrator,
  input: Parameters<Orchestrator["submitTask"]>[0],
  timeoutMs = 30000,
) {
  const rec = orch.submitTask(input);
  return (await orch.waitTask(rec.taskId, timeoutMs))!;
}

/* ------------------------------------------------------------------ */
/* end to end: the patch crosses the wire                              */
/* ------------------------------------------------------------------ */

test("a diff handoff to a remote worker ships the patch and rewrites its path", async () => {
  const ctx = await setup();
  try {
    const pred = await submit(ctx.master, { profile: "writer", prompt: "add the feature" });
    assert.equal(pred.status, "succeeded");

    const succ = await submit(ctx.master, {
      profile: "remote-sink",
      prompt: "review the patch",
      handoff: { fromTaskId: pred.taskId, inject: "diff" },
    });
    assert.equal(succ.status, "succeeded", succ.error?.message);

    // The daemon staged it under its own state dir, named after the master's task.
    const staged = path.join(ctx.daemonWorkdir, "handoffs", `${succ.taskId}.diff`);
    assert.ok(existsSync(staged), `expected staged artifact at ${staged}`);

    const content = readFileSync(staged, "utf8");
    assert.match(content, /feature: add health check/);
    assert.doesNotMatch(content, /AKIAIOSFODNN7EXAMPLE/, "secrets must be redacted before shipping");

    // The master's own copy still exists (it is what the local record points at).
    const local = path.join(ctx.masterWorkdir, "handoffs", `${succ.taskId}.diff`);
    assert.equal(readFileSync(local, "utf8"), content);

    // The daemon replaced the token with a real path before the agent saw it.
    const remoteTask = ctx.daemon.listTasks().find((t) => t.prompt.includes("working-tree-diff"));
    assert.ok(remoteTask, "expected the daemon to hold the remote task");
    assert.ok(remoteTask.prompt.includes(staged), "prompt must name the staged absolute path");
    assert.doesNotMatch(remoteTask.prompt, /\{\{artifact:/, "the token must not survive");
  } finally {
    await ctx.stop();
  }
});

test("a patch above the artifact ceiling is refused instead of sent", async () => {
  const ctx = await setup();
  try {
    const pred = await submit(ctx.master, { profile: "big-writer", prompt: "write a big file" });
    assert.equal(pred.status, "succeeded");

    const succ = await submit(ctx.master, {
      profile: "remote-sink",
      prompt: "review",
      // Raising the cap past the protocol ceiling must fail, not truncate.
      handoff: { fromTaskId: pred.taskId, inject: "diff", maxBytes: 8 * 1024 * 1024 },
    });
    assert.equal(succ.status, "failed");
    assert.equal(succ.error?.code, "handoff_artifact_too_large");

    const dir = path.join(ctx.daemonWorkdir, "handoffs");
    assert.equal(existsSync(dir), false, "nothing may be staged when the patch is refused");
  } finally {
    await ctx.stop();
  }
});

/* ------------------------------------------------------------------ */
/* the receiver's guards                                               */
/* ------------------------------------------------------------------ */

const sha = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

function withWorkdir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-stage-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const code = (c: string) => (e: unknown) =>
  e instanceof SecurityError && e.code === c;

test("stageArtifacts writes a valid artifact with the name it was given", () => {
  withWorkdir((dir) => {
    const data = "diff --git a/x b/x\n";
    const [a] = stageArtifacts([{ name: "task-1.diff", data: Buffer.from(data).toString("base64"), sha256: sha(data) }], dir);
    assert.ok(a);
    assert.equal(readFileSync(a.path, "utf8"), data);
    assert.equal(a.bytes, Buffer.byteLength(data));
    assert.equal(path.dirname(a.path), path.join(dir, "handoffs"));
  });
});

test("stageArtifacts rejects a path masquerading as a name", () => {
  withWorkdir((dir) => {
    for (const name of ["../evil.diff", "sub/evil.diff", "C:\\evil.diff", "/tmp/evil.diff", "evil.txt"]) {
      assert.throws(
        () => stageArtifacts([{ name, data: Buffer.from("x").toString("base64"), sha256: sha("x") }], dir),
        code("artifact_invalid"),
        `expected "${name}" to be rejected`,
      );
    }
  });
});

test("stageArtifacts rejects an oversized artifact before writing", () => {
  withWorkdir((dir) => {
    const data = "0123456789A";
    assert.throws(
      () => stageArtifacts([{ name: "big.diff", data: Buffer.from(data).toString("base64"), sha256: sha(data) }], dir, 10),
      code("artifact_too_large"),
    );
    assert.equal(existsSync(path.join(dir, "handoffs")), false);
  });
});

test("stageArtifacts rejects a checksum mismatch and empty content", () => {
  withWorkdir((dir) => {
    assert.throws(
      () => stageArtifacts([{ name: "a.diff", data: Buffer.from("payload").toString("base64"), sha256: sha("other") }], dir),
      code("artifact_checksum_mismatch"),
    );
    assert.throws(
      () => stageArtifacts([{ name: "b.diff", data: "", sha256: sha("") }], dir),
      code("artifact_invalid"),
    );
    assert.equal(existsSync(path.join(dir, "handoffs")), false);
  });
});

/* ------------------------------------------------------------------ */
/* version skew                                                        */
/* ------------------------------------------------------------------ */

test("a v1 daemon is refused rather than sent an unusable prompt", async () => {
  // A protocol-v1 daemon has no artifact staging: it would ignore the attachment
  // and hand its agent a literal `{{artifact:0}}`. The client must refuse at the
  // handshake, not ship a prompt that cannot work.
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "welcome", protocol: 1, daemonId: "old", profiles: ["sink"] }));
  });

  const state = mkdtempSync(path.join(tmpdir(), "agentmesh-skew-"));
  const repo = makeRepo();
  const config = parseConfig({
    workdir: ".unused",
    profiles: [
      { name: "writer", driver: "mock", worktree: true, mock: { delayMs: 1, writeFiles: { "a.txt": "a\n" } } },
      {
        name: "old-daemon",
        driver: "remote",
        remote: { endpoint: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`, tokenEnv },
      },
    ],
  });
  const master = new Orchestrator(config, { baseCwd: repo, workdir: path.join(state, "m"), persist: false });
  try {
    const pred = await submit(master, { profile: "writer", prompt: "write a file" });
    const rec = master.submitTask({
      profile: "old-daemon",
      prompt: "review",
      handoff: { fromTaskId: pred.taskId, inject: "diff" },
    });
    const done = (await master.waitTask(rec.taskId, 15000))!;
    assert.equal(done.status, "failed");
    assert.match(done.error?.message ?? "", /protocol v1/);
    assert.match(done.error?.message ?? "", /protocol_mismatch/);
  } finally {
    await master.shutdown().catch(() => {});
    rmSync(state, { recursive: true, force: true });
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
});
