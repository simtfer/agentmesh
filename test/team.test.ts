import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { Team } from "../src/team/team.js";
import { TeamStore } from "../src/team/store.js";
import { startTeamServer } from "../src/team/server.js";
import { extractHandles } from "../src/team/mentions.js";
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
        },
        {
          id: "dev",
          name: "Sam",
          role: "engineer, writes the code",
          profile: "dev-h",
          ...(opts.pulse?.dev ? { pulse: opts.pulse.dev } : {}),
        },
        {
          id: "qa",
          name: "Lin",
          role: "verifier, tests what was built",
          profile: "qa-h",
          ...(opts.pulse?.qa ? { pulse: opts.pulse.qa } : {}),
        },
      ],
      channels: [
        { id: "general", description: "the whole team" },
        { id: "ops", description: "ceo and qa only", members: ["ceo", "qa"] },
      ],
      ...(opts.maxHops ? { maxHops: opts.maxHops } : {}),
      ...(opts.maxTurnsPerMessage ? { maxTurnsPerMessage: opts.maxTurnsPerMessage } : {}),
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
  } finally {
    await server.close();
    await cleanup(h, dir);
  }
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
