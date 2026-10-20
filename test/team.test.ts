import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Script } from "node:vm";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { Team } from "../src/team/team.js";
import { TeamStore } from "../src/team/store.js";
import { startTeamServer } from "../src/team/server.js";
import { renderConsoleHtml } from "../src/team/console.js";
import { extractHandles } from "../src/team/mentions.js";
import { WorkerDaemon } from "../src/remote/daemon.js";
import { NoopAuditLog } from "../src/remote/audit.js";
import type { TeamConfig } from "../src/team/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, timeoutMs = 5000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface TeamHarnessOptions {
  delayMs?: number;
  maxHops?: number;
  maxTurnsPerMessage?: number;
  persist?: boolean;
  requireApproval?: boolean;
  /** split every reply into this many streaming deltas, like a real driver */
  stream?: number;
  /** per-member pulse settings, keyed by member id */
  pulse?: Record<string, { everyMs: number; idleOnly?: boolean }>;
  /** per-member session rotation limit, keyed by member id */
  sessionTurns?: Record<string, number>;
  /** per-member claim settings, keyed by member id (list of channels) */
  claims?: Record<string, string[]>;
  /** how long an unaddressed message stays claimable */
  claimTtlMs?: number;
  replies?: { ceo?: string[]; dev?: string[]; qa?: string[] };
}

const DEFAULT_REPLIES = {
  ceo: ["@dev please implement the health endpoint"],
  dev: ["Implemented /health. @qa please verify it."],
  qa: ["Verified — the endpoint returns 200."],
};

function makeTeam(dir: string, opts: TeamHarnessOptions = {}) {
  const delayMs = opts.delayMs ?? 2;
  const replies = { ...DEFAULT_REPLIES, ...opts.replies };
  const stream = opts.stream ? { stream: opts.stream } : {};
  const config = parseConfig({
    workdir: path.join(dir, ".agentmesh"),
    profiles: [
      { name: "ceo-h", driver: "mock", mock: { delayMs, toolCalls: 1, replies: replies.ceo, ...stream } },
      { name: "dev-h", driver: "mock", mock: { delayMs, toolCalls: 2, replies: replies.dev, ...stream } },
      {
        name: "qa-h",
        driver: "mock",
        mock: {
          delayMs,
          toolCalls: 1,
          replies: replies.qa,
          ...stream,
          ...(opts.requireApproval ? { requireApproval: true } : {}),
        },
      },
    ],
    team: {
      name: "acme",
      members: [
        {
          id: "ceo",
          name: "Mira",
          role: "chief executive, splits goals into work",
          profile: "ceo-h",
          ...(opts.pulse?.ceo ? { pulse: opts.pulse.ceo } : {}),
          ...(opts.claims?.ceo ? { claims: opts.claims.ceo } : {}),
        },
        {
          id: "dev",
          name: "Sam",
          role: "engineer, writes the code",
          profile: "dev-h",
          ...(opts.pulse?.dev ? { pulse: opts.pulse.dev } : {}),
          ...(opts.sessionTurns?.dev ? { sessionTurns: opts.sessionTurns.dev } : {}),
          ...(opts.claims?.dev ? { claims: opts.claims.dev } : {}),
        },
        {
          id: "qa",
          name: "Lin",
          role: "verifier, tests what was built",
          profile: "qa-h",
          ...(opts.pulse?.qa ? { pulse: opts.pulse.qa } : {}),
          ...(opts.claims?.qa ? { claims: opts.claims.qa } : {}),
        },
      ],
      channels: [
        { id: "general", description: "the whole team" },
        { id: "ops", description: "ceo and qa only", members: ["ceo", "qa"] },
      ],
      ...(opts.maxHops ? { maxHops: opts.maxHops } : {}),
      ...(opts.maxTurnsPerMessage ? { maxTurnsPerMessage: opts.maxTurnsPerMessage } : {}),
      ...(opts.claimTtlMs !== undefined ? { claimTtlMs: opts.claimTtlMs } : {}),
    },
  });
  const orch = new Orchestrator(config, { baseCwd: dir, persist: false });
  const team = new Team({
    config: config.team as TeamConfig,
    orchestrator: orch,
    baseCwd: dir,
    stateDir: path.join(dir, "team"),
    persist: opts.persist ?? false,
  });
  return { config, orch, team };
}

async function cleanup(h: { team: Team; orch: Orchestrator }, dir: string): Promise<void> {
  await h.team.shutdown().catch(() => {});
  await h.orch.shutdown().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

const chat = (messages: Array<{ kind: string }>) =>
  messages.filter((m) => m.kind === "chat") as Array<{ author: string; text: string; mentions: string[] }>;

test("mention parsing ignores emails and accepts unicode handles", () => {
  assert.deepEqual(extractHandles("mail a@dev.io, ping @研发 and @dev/ops"), ["研发", "dev"]);
  assert.deepEqual(extractHandles("@CEO @ceo again"), ["ceo"]);
});

test("a group mention hands work down the chain and every reply lands in the channel", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  const h = makeTeam(dir);
  try {
    h.team.post({ channel: "general", text: "We need a /health endpoint. @ceo, take it." });
    await h.team.idle(10_000);

    const log = chat(h.team.messages("general"));
    assert.deepEqual(
      log.map((m) => m.author),
      ["user", "ceo", "dev", "qa"],
      "the CEO's reply should hand off to dev, whose reply hands off to qa",
    );
    assert.match(log[1]!.text, /@dev/);
    assert.deepEqual(log[1]!.mentions, ["dev"]);
    assert.match(log[3]!.text, /Verified/);

    // One live worker per member, each on its own pinned session.
    assert.equal(h.orch.listWorkers().length, 3);
    const ceo = h.team.status().members.find((m) => m.id === "ceo")!;
    assert.equal(ceo.sessionKey, "team:acme:ceo");
    assert.ok(ceo.workerId, "the CEO should have a live worker after speaking");
  } finally {
    await cleanup(h, dir);
  }
});

/**
 * The roster knows nothing about *where* a member runs. This is the contract
 * that lets a team outgrow one box: the middle member lives in another process
 * (a Worker Daemon over loopback WebSocket), the two around it are local, and
 * the hand-off chain behaves exactly the same.
 */
const REMOTE_TEAM_TOKEN_ENV = "AGENTMESH_TEAM_REMOTE_TOKEN";
process.env[REMOTE_TEAM_TOKEN_ENV] = "team-remote-test-token";

test("a member can live on another process and still pass work down the chain", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-remote-"));
  const daemonConfig = parseConfig({
    workdir: path.join(dir, "daemon-state"),
    profiles: [
      {
        name: "remote-dev",
        driver: "mock",
        mock: {
          delayMs: 2,
          toolCalls: 2,
          replies: ["Built /health on the far side. @qa please verify it."],
        },
      },
    ],
  });
  const dOrch = new Orchestrator(daemonConfig, { baseCwd: dir, persist: false });
  const daemon = new WorkerDaemon({
    config: daemonConfig,
    orchestrator: dOrch,
    host: "127.0.0.1",
    port: 0,
    token: process.env[REMOTE_TEAM_TOKEN_ENV]!,
    allowCwd: [dir],
    audit: new NoopAuditLog(),
  });
  const info = await daemon.start();

  const config = parseConfig({
    workdir: path.join(dir, ".agentmesh"),
    profiles: [
      { name: "ceo-h", driver: "mock", mock: { delayMs: 2, replies: ["@dev please implement /health"] } },
      {
        name: "dev-h",
        driver: "remote",
        remote: { endpoint: info.url, tokenEnv: REMOTE_TEAM_TOKEN_ENV, remoteProfile: "remote-dev" },
      },
      { name: "qa-h", driver: "mock", mock: { delayMs: 2, replies: ["Verified — it returns 200."] } },
    ],
    team: {
      name: "acme",
      members: [
        { id: "ceo", name: "Mira", role: "chief executive", profile: "ceo-h" },
        { id: "dev", name: "Sam", role: "engineer", profile: "dev-h" },
        { id: "qa", name: "Lin", role: "verifier", profile: "qa-h" },
      ],
      channels: [{ id: "general", description: "the whole team" }],
    },
  });
  const orch = new Orchestrator(config, { baseCwd: dir, persist: false });
  const team = new Team({
    config: config.team as TeamConfig,
    orchestrator: orch,
    baseCwd: dir,
    stateDir: path.join(dir, "team"),
    persist: false,
  });

  try {
    team.post({ channel: "general", text: "@ceo we need a /health endpoint" });
    await team.idle(20_000);

    const log = chat(team.messages("general"));
    assert.deepEqual(log.map((m) => m.author), ["user", "ceo", "dev", "qa"]);
    assert.match(log[2]!.text, /far side/, "the middle reply has to come back over the socket");

    // Proof it really crossed the boundary: the task exists on the far side
    // under the daemon-side profile name, and locally the member is one proxied
    // task rather than a second run.
    const far = dOrch.listTasks({ limit: 5 });
    assert.equal(far.length, 1, "exactly one task ran on the daemon");
    assert.equal(far[0]!.profile, "remote-dev");
    assert.equal(far[0]!.status, "succeeded");
    assert.equal(
      orch.listTasks({ limit: 20 }).filter((t) => t.profile === "dev-h").length,
      1,
      "a remote member is one proxied task, not a local duplicate",
    );

    // Everything downstream still treats it as an ordinary member.
    const dev = team.status().members.find((m) => m.id === "dev")!;
    assert.equal(dev.sessionKey, "team:acme:dev");
    assert.equal(team.transcript("dev", 5)[0]!.status, "succeeded");
  } finally {
    await team.shutdown().catch(() => {});
    await orch.shutdown().catch(() => {});
    await daemon.stop().catch(() => {});
    await dOrch.shutdown().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a DM stays out of the group channel, and pulls a teammate in only when named", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  const h = makeTeam(dir, {
    replies: { qa: ["All green. @dev, can you look at the flaky test?"], dev: ["On it."] },
  });
  try {
    h.team.dm("qa", "How is the release looking?");
    await h.team.idle(10_000);

    const dm = chat(h.team.messages("dm:user:qa"));
    assert.deepEqual(dm.map((m) => m.author), ["user", "qa", "dev"]);
    assert.equal(chat(h.team.messages("general")).length, 0);

    const dmChannel = h.team.channels().find((c) => c.id === "dm:user:qa")!;
    assert.equal(dmChannel.kind, "dm");
    assert.deepEqual(dmChannel.members.sort(), ["dev", "qa"]);
  } finally {
    await cleanup(h, dir);
  }
});

test("one member takes turns serially while different members run in parallel", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  const h = makeTeam(dir, { delayMs: 40, replies: { ceo: ["Noted."], dev: ["Working."], qa: ["Fine."] } });
  try {
    h.team.post({ channel: "general", text: "@ceo first" });
    h.team.post({ channel: "general", text: "@ceo second" });
    await until(() => h.team.status().running === 1, 3000, "the first CEO turn to start");
    await h.team.idle(10_000);

    const ceoTurns = h.team.transcript("ceo", 10);
    assert.equal(ceoTurns.length, 2);
    assert.ok(ceoTurns[1]!.startedAt! >= ceoTurns[0]!.endedAt!, "a member's turns must not overlap");
    assert.equal(h.orch.listWorkers().filter((w) => w.profile === "ceo-h").length, 1);

    h.team.post({ channel: "general", text: "@dev and @qa, take a look together" });
    await until(() => h.team.status().running === 2, 3000, "both members to run at once");
    assert.deepEqual(
      h.team.status().members.filter((m) => m.status === "running").map((m) => m.id).sort(),
      ["dev", "qa"],
    );
    await h.team.idle(10_000);
  } finally {
    await cleanup(h, dir);
  }
});

test("hand-off depth stops a ping-pong with an explanation in the channel", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  const h = makeTeam(dir, {
    maxHops: 2,
    maxTurnsPerMessage: 20,
    replies: { ceo: ["@dev over to you"], dev: ["@ceo your turn again"] },
  });
  try {
    h.team.post({ channel: "general", text: "@ceo start" });
    await h.team.idle(10_000);

    assert.equal(h.team.transcript("ceo", 10).length, 1);
    assert.equal(h.team.transcript("dev", 10).length, 1);
    const all = h.team.messages("general");
    assert.ok(
      all.some((m) => m.kind === "system" && /hand-off depth 2 reached/.test(m.text)),
      "hitting the hop cap must be visible, not silent",
    );
  } finally {
    await cleanup(h, dir);
  }
});

test("the per-thread turn cap refuses extra mentions", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  const h = makeTeam(dir, { maxTurnsPerMessage: 1 });
  try {
    h.team.post({ channel: "general", text: "@ceo @dev @qa all three of you" });
    await h.team.idle(10_000);
    assert.equal(h.team.status().queued, 0);
    assert.ok(
      h.team.messages("general").some((m) => m.kind === "system" && /turn cap 1/.test(m.text)),
    );
  } finally {
    await cleanup(h, dir);
  }
});

test("queued turns survive a restart, interrupted work is reported honestly", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  const first = makeTeam(dir, { delayMs: 150, persist: true, replies: { ceo: ["@dev go", "Done."] } });
  try {
    first.team.post({ channel: "general", text: "@ceo slow job" });
    first.team.post({ channel: "general", text: "@ceo queued job" });
    await until(() => first.team.status().running === 1, 5000, "the slow turn to start");
  } finally {
    await first.team.shutdown();
    await first.orch.shutdown();
  }

  const second = makeTeam(dir, { delayMs: 2, persist: true });
  try {
    await second.team.idle(10_000);
    const all = second.team.messages("general");
    assert.ok(
      all.some((m) => m.kind === "system" && /interrupted/.test(m.text)),
      "the turn that was running must be reported as interrupted",
    );
    const ceoChat = all.filter((m) => m.kind === "chat" && m.author === "ceo");
    assert.equal(ceoChat.length, 1, "the queued turn must run once after the restart");
  } finally {
    await cleanup(second, dir);
  }
});

test("a member blocked on a permission request is visible and resumes after approval", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  const h = makeTeam(dir, { requireApproval: true, replies: { qa: ["Approved and done."] } });
  try {
    h.team.post({ channel: "general", text: "@qa run the destructive check" });
    await until(() => h.team.status().waiting === 1, 5000, "the member to block on an approval");
    assert.equal(h.team.status().members.find((m) => m.id === "qa")!.status, "waiting");

    const [approval] = h.team.approvals();
    assert.ok(approval);
    assert.equal(approval.kind, "permission");
    assert.equal(h.team.approve(approval.approvalId, "allow_once"), true);
    await h.team.idle(10_000);

    const [turn] = h.team.transcript("qa", 1);
    assert.equal(turn!.status, "succeeded");
    assert.ok(h.team.messages("general").some((m) => m.author === "qa" && /Approved and done/.test(m.text)));
  } finally {
    await cleanup(h, dir);
  }
});

test("transcript exposes the task events behind a turn", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  const h = makeTeam(dir, { replies: { dev: ["Done."], ceo: ["@dev go"], qa: ["Ok."] } });
  try {
    h.team.post({ channel: "general", text: "@dev implement it" });
    await h.team.idle(10_000);

    const [turn] = h.team.transcript("dev", 5);
    assert.ok(turn);
    assert.equal(turn.status, "succeeded");
    assert.equal(turn.taskStatus, "succeeded");
    assert.ok(turn.events.length > 0, "tool/status events should be visible per turn");
    assert.ok(turn.events.some((e) => e.type === "output"));
  } finally {
    await cleanup(h, dir);
  }
});

test("a streaming member reads as prose, not as a wall of deltas", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  const reply = "Implemented /health and left the migration for @qa.";
  const h = makeTeam(dir, { stream: 12, replies: { dev: [reply] } });
  try {
    h.team.post({ channel: "general", text: "@dev build it" });
    await h.team.idle(10_000);

    const [turn] = h.team.transcript("dev", 1);
    const text = (turn?.events ?? []).filter((e) => e.data?.kind === "text");
    assert.equal(text.length, 1, "twelve deltas must read as one line");
    assert.equal(text[0]!.text, reply);
    assert.equal(text[0]!.data?.chunks, 12);
    // Tool calls stay one per line: each is a distinct action, not a fragment.
    assert.ok((turn?.events ?? []).filter((e) => e.data?.kind === "tool").length >= 2);
  } finally {
    await cleanup(h, dir);
  }
});

test("a member's memory file is injected into the next turn", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  const h = makeTeam(dir, { replies: { ceo: ["Noted."] } });
  try {
    const memory = path.join(dir, "team", "members", "ceo", "MEMORY.md");
    mkdirSync(path.dirname(memory), { recursive: true });
    writeFileSync(memory, "Launch code is 417. The user prefers short updates.\n", "utf8");

    h.team.post({ channel: "general", text: "@ceo status?" });
    await h.team.idle(10_000);

    const [turn] = h.team.transcript("ceo", 1);
    const prompt = h.orch.taskStatus(turn!.taskId!)!.prompt;
    assert.match(prompt, /Launch code is 417/);
    assert.match(prompt, /You are Mira \(@ceo\)/);
    assert.match(prompt, /Team|team/);
  } finally {
    await cleanup(h, dir);
  }
});

test("a long conversation is rotated, and the retired worker goes with it", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  const h = makeTeam(dir, {
    sessionTurns: { dev: 2 },
    replies: { dev: ["one", "two", "three"] },
  });
  try {
    for (const text of ["first", "second", "third"]) {
      h.team.post({ channel: "general", text: `@dev ${text}` });
      await h.team.idle(10_000);
    }

    const turns = h.team.transcript("dev", 10);
    assert.equal(turns.length, 3);
    assert.deepEqual(
      turns.map((t) => t.sessionKey),
      ["team:acme:dev", "team:acme:dev", "team:acme:dev#1"],
      "the third turn is on a fresh conversation, and the record says so per turn",
    );

    // The roster reports where the member is *now*, not where it started.
    const dev = h.team.status().members.find((m) => m.id === "dev")!;
    assert.equal(dev.sessionKey, "team:acme:dev#1");
    assert.equal(dev.sessionGeneration, 1);
    assert.ok(
      dev.workerId,
      "rotation moves the conversation, not the desk: the member still has a live process",
    );

    // Rotating the key without closing the old process would leak one agent per
    // generation — exactly the cost rotation exists to avoid.
    const workers = h.orch.listWorkers().filter((w) => w.profile === "dev-h");
    assert.equal(workers.length, 1);
    assert.equal(workers[0]!.sessionKey, "team:acme:dev#1");

    // Said once, in the room: a member that "forgets" should look like a fresh
    // session, not like a defect.
    const notices = h.team.messages("general").filter((m) => m.kind === "system");
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.text, /fresh session/);
  } finally {
    await cleanup(h, dir);
  }
});

test("the rotation clock lives in the database, so a restart does not rewind it", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  const first = makeTeam(dir, {
    sessionTurns: { dev: 2 },
    persist: true,
    replies: { dev: ["one", "two", "three"] },
  });
  try {
    for (const text of ["first", "second", "third"]) {
      first.team.post({ channel: "general", text: `@dev ${text}` });
      await first.team.idle(10_000);
    }
    assert.equal(
      first.team.transcript("dev", 1)[0]!.sessionKey,
      "team:acme:dev#1",
      "three settled turns at a limit of two put the member on generation one",
    );
  } finally {
    await first.team.shutdown();
    await first.orch.shutdown();
  }

  const second = makeTeam(dir, {
    sessionTurns: { dev: 2 },
    persist: true,
    replies: { dev: ["after the restart"] },
  });
  try {
    second.team.post({ channel: "general", text: "@dev again" });
    await second.team.idle(10_000);
    assert.equal(
      second.team.transcript("dev", 1)[0]!.sessionKey,
      "team:acme:dev#1",
      "a restart must resume the current generation, not silently restart from zero",
    );
  } finally {
    await cleanup(second, dir);
  }
});

test("a message nobody was named in is picked up by a member who claims work", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  const h = makeTeam(dir, {
    claims: { dev: ["general"] },
    replies: { dev: ["Pinned the seed in ci.yml — the flake came from the shuffle order."] },
  });
  try {
    const posted = h.team.postWithTurns({
      channel: "general",
      text: "The ci test is flaky. Someone should pin it.",
    });
    assert.equal(posted.turns.length, 1, "nobody was named, so the mention router hands it to no one");
    assert.equal(
      posted.turns[0]!.kind,
      "claim",
      "the turn exists because a claimant picked the message up, not because it was addressed",
    );

    await h.team.idle(10_000);

    const log = chat(h.team.messages("general"));
    assert.deepEqual(
      log.map((m) => m.author),
      ["user", "dev"],
      "the claimant answers the message nobody was addressed in",
    );
    assert.match(log[1]!.text, /Pinned the seed/);
    assert.equal(log[1]!.replyTo, posted.message.id, "the reply answers the original message");

    const turns = h.team.transcript("dev");
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.kind, "claim", "a claim is a turn like any other, just with a different reason");
    assert.equal(turns[0]!.status, "succeeded");
    assert.equal(turns[0]!.messageId, posted.message.id);
    assert.equal(turns[0]!.hops, 0, "the message was a root, not a hand-off");

    assert.deepEqual(h.team.board("general"), [], "finished work leaves the board");
    assert.equal(h.team.status().unclaimed, 0);
  } finally {
    await cleanup(h, dir);
  }
});

test("a claim that is passed on goes back to the room instead of dying with one refusal", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  const h = makeTeam(dir, {
    claims: { dev: ["general"], qa: ["general"] },
    replies: {
      dev: ["SILENT"],
      qa: ["Reproduced it twice with --seed 7; the fixture leaks state between tests."],
    },
  });
  try {
    h.team.post({ channel: "general", text: "Something is wrong with the nightly job." });
    await h.team.idle(10_000);

    const log = chat(h.team.messages("general"));
    assert.deepEqual(
      log.map((m) => m.author),
      ["user", "qa"],
      "a member that passes on work says nothing at all",
    );

    const devTurns = h.team.transcript("dev");
    assert.equal(devTurns.length, 1);
    assert.equal(devTurns[0]!.kind, "claim");
    assert.equal(devTurns[0]!.status, "succeeded", "passing on work is a decision, not a failure");

    const qaTurns = h.team.transcript("qa");
    assert.equal(qaTurns.length, 1, "the item was released to the next claimant, not held by the first");
    assert.equal(qaTurns[0]!.kind, "claim");

    assert.deepEqual(h.team.board("general"), [], "qa finished it, so it left the board");
  } finally {
    await cleanup(h, dir);
  }
});

test("two members cannot claim the same message", () => {
  const store = new TeamStore(":memory:");
  try {
    const msg = store.createMessage({
      channel: "general",
      author: "user",
      authorName: "user",
      text: "fix the flaky test",
    });
    assert.equal(store.claimFor(msg.id, "dev"), true);
    assert.equal(store.claimFor(msg.id, "qa"), false, "the second claimant has to walk away");
    assert.equal(store.claimFor(msg.id, "dev"), false, "and so has the same member asking twice");
    const board = store.board("general", 0);
    assert.equal(board.length, 1);
    assert.equal(board[0]!.claimedBy, "dev");

    // A refusal is a per-member fact, not a verdict on the work: the item stays
    // claimable by everyone else, and the member that passed is not asked twice.
    const second = store.createMessage({
      channel: "general",
      author: "user",
      authorName: "user",
      text: "and the nightly job too",
    });
    assert.equal(store.claimFor(second.id, "dev"), true);
    store.setClaim(second.id, "dev", "declined");
    assert.equal(store.claimFor(second.id, "dev"), false, "the member that passed is not asked again");
    assert.equal(store.claimFor(second.id, "qa"), true, "but the work is still there for a colleague");
    assert.equal(store.claimFor(second.id, "ceo"), false);
    assert.deepEqual(store.board("general", 0)[1]!.declinedBy, ["dev"]);
  } finally {
    store.close();
  }
});

test("the board forgets work that is too old to be useful", () => {
  const store = new TeamStore(":memory:");
  try {
    store.createMessage({
      channel: "general",
      author: "user",
      authorName: "user",
      text: "yesterday's remark",
      createdAt: Date.now() - 2 * 3600_000,
    });
    assert.equal(store.board("general", 3600_000).length, 0);
    assert.equal(store.unclaimedCount(3600_000), 0);
    assert.equal(store.board("general", 0).length, 1, "a TTL of 0 means never");
  } finally {
    store.close();
  }
});

test("work the room passed on is reported after it leaves the board, not deleted with it", () => {
  const store = new TeamStore(":memory:");
  try {
    const old = Date.now() - 2 * 3600_000;
    const passed = store.createMessage({
      channel: "general",
      author: "user",
      authorName: "user",
      text: "rewrite the retry notes",
      createdAt: old,
    });
    store.setClaim(passed.id, "dev", "declined");
    store.setClaim(passed.id, "qa", "declined");
    const recent = store.createMessage({
      channel: "general",
      author: "user",
      authorName: "user",
      text: "still recent enough to claim",
    });
    store.setClaim(recent.id, "dev", "declined");
    // Somebody passed, somebody else took it and finished: that is a job done,
    // not a job nobody wanted.
    const finished = store.createMessage({
      channel: "general",
      author: "user",
      authorName: "user",
      text: "migration notes",
      createdAt: old,
    });
    store.setClaim(finished.id, "ceo", "declined");
    store.setClaim(finished.id, "dev", "done");

    assert.equal(store.board("general", 3600_000).length, 1, "only the recent item is live work");
    const gone = store.expiredBoard("general", 3600_000);
    assert.deepEqual(
      gone.map((i) => i.message.text),
      ["rewrite the retry notes"],
    );
    assert.deepEqual(gone[0]!.declinedBy, ["dev", "qa"], "who read it and passed, oldest first");
    assert.equal(gone[0]!.claimedBy, undefined, "a report, not work — nobody holds it");
    assert.equal(store.expiredBoard(undefined, 3600_000).length, 1, "the status count matches");
  } finally {
    store.close();
  }
});

test("an expiry nobody was ever offered is silence, not a refusal", () => {
  const store = new TeamStore(":memory:");
  try {
    // A room where no member claims: messages expire one at a time and no
    // member ever reads them. Reporting that as "nobody took it" would be a
    // complaint about a feature that was never switched on.
    store.createMessage({
      channel: "general",
      author: "user",
      authorName: "user",
      text: "nobody's queue",
      createdAt: Date.now() - 2 * 3600_000,
    });
    assert.deepEqual(store.expiredBoard("general", 3600_000), []);
    assert.equal(store.expiredBoard(undefined, 3600_000).length, 0, "the status count agrees");
    assert.deepEqual(store.expiredBoard("general", 0), [], "a TTL of 0 never expires anything");
  } finally {
    store.close();
  }
});

test("naming someone still hands them the work directly", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  const h = makeTeam(dir, { claims: { dev: ["general"] } });
  try {
    h.team.post({ channel: "general", text: "@dev the health check returns 500" });
    await h.team.idle(10_000);

    const turns = h.team.transcript("dev");
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.kind, "message", "an addressed message is answered, not claimed");
    assert.deepEqual(h.team.board("general"), [], "an addressed message never reaches the board");
  } finally {
    await cleanup(h, dir);
  }
});

test("the HTTP API serves the team and requires a token", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  const h = makeTeam(dir);
  const server = await startTeamServer({ team: h.team, port: 0, tokens: ["s3cret"] });
  const auth = { authorization: "Bearer s3cret", "content-type": "application/json" };
  try {
    assert.equal((await fetch(`${server.url}/team`)).status, 401);
    assert.equal((await fetch(`${server.url}/healthz`)).status, 200);

    const posted = await fetch(`${server.url}/team/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ channel: "general", text: "Status please, @ceo" }),
    });
    assert.equal(posted.status, 201);
    await h.team.idle(10_000);

    const status = (await (await fetch(`${server.url}/team`, { headers: auth })).json()) as {
      members: Array<{ id: string; status: string }>;
      running: number;
    };
    assert.equal(status.running, 0);
    assert.ok(status.members.every((m) => m.status === "idle"));

    const log = (await (
      await fetch(`${server.url}/team/messages?channel=general&limit=20`, { headers: auth })
    ).json()) as { messages: Array<{ author: string }> };
    assert.ok(log.messages.some((m) => m.author === "ceo"));

    const tr = (await (
      await fetch(`${server.url}/team/members/ceo/transcript?limit=5`, { headers: auth })
    ).json()) as { turns: Array<{ status: string }> };
    assert.equal(tr.turns[0]!.status, "succeeded");

    // The route carries both halves of the board: live work, and what expired
    // after somebody had already read it. A CLI that only ever saw `items`
    // could not tell "the room is quiet" from "the room passed on your work".
    const board = (await (
      await fetch(`${server.url}/team/board?channel=general`, { headers: auth })
    ).json()) as { items: unknown[]; expired: unknown[] };
    assert.deepEqual(board.items, [], "the addressed message was answered, so nothing is open");
    assert.deepEqual(board.expired, [], "and nothing expired either");
  } finally {
    await server.close();
    await cleanup(h, dir);
  }
});

test("the console shell loads without a token, and every number on it still needs one", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  const h = makeTeam(dir);
  const server = await startTeamServer({ team: h.team, port: 0, tokens: ["s3cret"] });
  try {
    const res = await fetch(`${server.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/html/);

    // A page anyone can open must not be able to reach anywhere or anything:
    // no external assets, no eval source, no framing, no form posts.
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");

    const html = await res.text();
    assert.match(html, /read-only/);
    assert.match(html, /WANTS_TOKEN = true/, "the page knows to ask for a token");
    // Read-only is a property of the document, not a promise in the docs.
    assert.doesNotMatch(html, /method:\s*["']POST["']/);
    assert.doesNotMatch(html, /team\/approvals/);

    // The shell is public; the data behind it is not.
    assert.equal((await fetch(`${server.url}/team`)).status, 401);
    assert.equal((await fetch(`${server.url}/team/messages?channel=general`)).status, 401);
    assert.equal((await fetch(`${server.url}/favicon.ico`)).status, 204);
  } finally {
    await server.close();
    await cleanup(h, dir);
  }
});

test("the console refuses to trust the team name", () => {
  const html = renderConsoleHtml({ teamName: '<img src=x onerror="alert(1)">', requiresToken: false });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /WANTS_TOKEN = false/, "an open team must not nag for a token");
});

test("the console's inline script compiles", () => {
  const html = renderConsoleHtml({ teamName: "acme", requiresToken: false });
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, "the page ships its own script");
  // Compiles, never runs. The page is one big template literal, so a stray
  // backtick inside it closes the string early and leaves the rest as code —
  // which is exactly how the first draft of this file ended up answering 500.
  new Script(script);
});

test("the roster rejects duplicate handles instead of guessing who @dev means", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  try {
    const config = parseConfig({
      profiles: [{ name: "mock-h", driver: "mock" }],
      team: {
        members: [
          { id: "a", mention: "dev", profile: "mock-h" },
          { id: "dev", profile: "mock-h" },
        ],
      },
    });
    const orch = new Orchestrator(config, { baseCwd: dir, persist: false });
    assert.throws(
      () => new Team({ config: config.team as TeamConfig, orchestrator: orch, baseCwd: dir, persist: false }),
      /claimed by both/,
    );
    void orch.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("a member with a pulse wakes on its own, and silence keeps the room quiet", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  const h = makeTeam(dir, { pulse: { ceo: { everyMs: 1000 } }, replies: { ceo: ["SILENT"] } });
  try {
    // Nobody speaks: only the timer can create this turn.
    await until(
      () => h.team.transcript("ceo", 5).some((t) => t.kind === "pulse"),
      5000,
      "a pulse turn",
    );
    await h.team.idle(10_000);

    const pulse = h.team.transcript("ceo", 5).find((t) => t.kind === "pulse")!;
    assert.equal(pulse.status, "succeeded");
    assert.equal(pulse.messageId, undefined, "a pulse has nothing to answer");
    assert.equal(pulse.rootId, undefined, "a pulse does not continue someone else's thread");

    // The prompt has to make silence cheap and explicit, or every wake-up
    // becomes a "no update" post.
    const prompt = h.orch.taskStatus(pulse.taskId!)!.prompt;
    assert.match(prompt, /Nobody is talking to you/);
    assert.match(prompt, /SILENT/);
    assert.match(prompt, /every 1 second/, "the member is told its own cadence");

    assert.equal(
      chat(h.team.messages("general")).filter((m) => m.author === "ceo").length,
      0,
      "SILENT must post nothing",
    );
    assert.equal(
      h.team.messages("general").filter((m) => m.kind === "system").length,
      0,
      "silence must not be announced either",
    );
  } finally {
    await cleanup(h, dir);
  }
});

test("a pulse that has something to say starts its own thread and can hand off", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  const h = makeTeam(dir, {
    pulse: { ceo: { everyMs: 3_600_000 } },
    replies: { ceo: ["Build is green. @dev, ship it."], dev: ["Shipped."] },
  });
  try {
    const queued = h.team.pulseNow("ceo");
    assert.ok(queued, "an idle member with a pulse can be woken on demand");
    await h.team.idle(10_000);

    const log = h.team.messages("general").filter((m) => m.kind === "chat");
    assert.deepEqual(log.map((m) => m.author), ["ceo", "dev"]);
    assert.deepEqual(log[0]!.mentions, ["dev"], "the wake-up message is a normal message");

    const dev = h.team.transcript("dev", 1)[0]!;
    assert.equal(dev.hops, 1);
    assert.equal(dev.rootId, log[0]!.id, "the pulse message roots the new thread");
    assert.equal(
      h.team.transcript("ceo", 1)[0]!.rootId,
      undefined,
      "but the pulse turn itself belongs to no thread, so it cannot spend another one's budget",
    );
  } finally {
    await cleanup(h, dir);
  }
});

test("a pulse never talks over work that is already in progress", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  const h = makeTeam(dir, {
    pulse: { ceo: { everyMs: 3_600_000 }, qa: { everyMs: 3_600_000, idleOnly: false } },
    replies: { ceo: ["SILENT"], dev: ["Done. @qa check it."], qa: ["Checked."] },
  });
  try {
    h.team.post({ channel: "general", text: "@dev do it" });
    assert.equal(
      h.team.pulseNow("ceo"),
      undefined,
      "an idleOnly member stays asleep while anyone in the team is working",
    );
    assert.ok(
      h.team.pulseNow("qa"),
      "idleOnly: false opts out of the room-wide gate (for a lead reporting progress)",
    );

    await h.team.idle(20_000);
    assert.ok(
      h.team.pulseNow("ceo"),
      "once the room is quiet again the same member is allowed to wake",
    );
  } finally {
    await cleanup(h, dir);
  }
});

test("a member without a pulse only ever answers", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  const h = makeTeam(dir);
  try {
    assert.equal(h.team.pulseNow("ceo"), undefined, "no pulse configured, no wake-up");
    h.team.post({ channel: "general", text: "@ceo status?" });
    await h.team.idle(10_000);
    assert.equal(h.team.transcript("ceo", 5).filter((t) => t.kind === "pulse").length, 0);
    assert.equal(h.team.status().members.find((m) => m.id === "ceo")!.pulseEveryMs, undefined);
  } finally {
    await cleanup(h, dir);
  }
});

test("a team database from before pulses still opens and keeps its turns", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-team-"));
  const dbPath = path.join(dir, "team.sqlite");
  // The v1 shape: every turn had to answer a message (both columns NOT NULL).
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`CREATE TABLE turns (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    memberId TEXT NOT NULL,
    channel TEXT NOT NULL,
    messageId TEXT NOT NULL,
    rootId TEXT NOT NULL,
    hops INTEGER NOT NULL,
    taskId TEXT,
    status TEXT NOT NULL,
    queuedAt INTEGER NOT NULL,
    startedAt INTEGER,
    endedAt INTEGER,
    approvalId TEXT,
    error TEXT
  );`);
  legacy
    .prepare(
      `INSERT INTO turns (id, memberId, channel, messageId, rootId, hops, status, queuedAt)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run("turn-old", "ceo", "general", "msg-1", "msg-1", 0, "succeeded", 1);
  legacy.close();

  const store = new TeamStore(dbPath);
  try {
    const old = store.getTurn("turn-old")!;
    assert.equal(old.messageId, "msg-1", "existing rows survive the rebuild");
    assert.equal(old.kind, "message", "history defaults to message turns");

    const pulse = store.createTurn({ memberId: "ceo", channel: "general", kind: "pulse", hops: 0 });
    assert.equal(pulse.kind, "pulse");
    assert.equal(pulse.messageId, undefined);
    assert.ok(pulse.seq > old.seq, "the id sequence continues instead of restarting");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
