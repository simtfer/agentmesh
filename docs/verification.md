# Verification

What agentmesh's test suite actually covers, and how to re-run it yourself.
This is the detailed counterpart to the short [Verification](../README.md#verification)
section in the README; keep the per-case lists here so the front page stays readable.

## Environment

| | |
|---|---|
| OS | Windows 11 and Ubuntu — CI runs the suite on `ubuntu-latest` and `windows-latest` (see [CI](#ci)) |
| Node | v22.22 (`engines: >=22.13`; `node:sqlite` is built in, no native deps) |
| Network | not required — every test uses mocks or a loopback daemon |
| Cost | zero — no model API is called unless you run `npm run real` |

## Reproduce

```bash
npm run typecheck   # tsc --noEmit, clean
npm test            # 166 tests, offline, ~27s
npm run demo        # Scene A + Scene B, ends with "Scene A CLOSED ✅ | Scene B CLOSED ✅"
npm run smoke       # real MCP server over stdio through the full lifecycle
npm run deploy:tls  # TLS + mTLS over this host's LAN address (not loopback), ~2s
npm run real        # real local opencode + pi workers (needs both installed & authenticated)
npm run check:pack  # asserts the publish tarball contains dist/ and no sources
```

`npm test` runs the twelve files below with `tsx --test`. Nothing is skipped, nothing
is marked `todo`, and no test asserts a mock's internal calls in place of
observable behaviour — each one drives the public surface (Orchestrator, MCP
tools, or the daemon's HTTP/WS endpoints) and checks the resulting task record.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs the same commands on
a matrix of `ubuntu-latest` and `windows-latest` × Node 22 and 24, on every push to
`main` and every pull request:

```text
npm ci → npm run typecheck → npm test → npm run build → npm run demo → npm run smoke → npm run check:pack
```

Two of those steps exist only because of what a developer machine cannot see:

- **`npm run build` must precede `check:pack`.** `dist/` is gitignored, so the
  pack check is the only evidence that a tarball would be complete: it fails when
  `bin`/`exports` targets are missing, and when `src/`, `test/`, `.github/`, local
  state or `.env` end up in it. `prepack` now runs build + check for anyone
  publishing (see [`release.md`](./release.md)); CI deliberately builds first and
  runs the check with `--ignore-scripts`, because a check that silently builds can
  never tell you the build was forgotten.
- **Linux is the case-sensitivity check.** Windows resolves `./Foo.js` against
  `foo.ts`; Linux does not. The matrix is what makes any such slip fail during
  review rather than for the first Linux user.

`npm run deploy:tls` is deliberately **not** in CI: it binds this host's LAN
address and asserts a real interface, which a hosted runner does not have.

The workflow earned its keep on its first run: both Windows legs failed on two
cases that pass on the development machine — a `base: "predecessor"` handoff
refused because two spellings of one temp directory compared unequal, and a skill
frontmatter assertion that assumed LF in a CRLF checkout. Both were real defects
in the product and the test respectively, not runner quirks.

## `test/tasks.test.ts` — 32 cases

The lifecycle core. Covers, in order:

- **Happy path / failure.** `queued → starting → running → succeeded` with the
  event log persisted; a throwing worker surfaces `failed` with its message.
- **Timeout and cancel.** `timeout → timed_out`; `cancel → cancelled` for a
  running task, settling only once the worker confirms.
- **Approvals.** `waiting → approve → succeeded` through the broker; rejecting a
  permission request fails the task.
- **Idempotency.** A replayed `idempotencyKey` returns the original task instead
  of spawning a second worker.
- **Persistence.** A SQLite store survives an orchestrator restart (persist, then
  re-query from a fresh instance); `update()` merges fields without clobbering
  columns the caller left unset; an **old-schema DB is forward-migrated** with the
  `deadlineAt`, `structured` and `usage` columns on open.
- **Recursion guard.** A delegation within the cap succeeds and stamps its depth
  into metadata; a submit *at* the cap is refused with `delegation_depth_exceeded`
  and spawns no worker; an inherited `AGENTMESH_DELEGATION_DEPTH` raises the
  effective depth and trips the cap.
- **Resource limits.** A submit past `maxConcurrentTasks` is refused without
  spawning a worker; a settling task frees its slot for the next submit; an
  oversized result is truncated and flagged `outputTruncated`; truncation never
  splits a multibyte codepoint.
- **Scheduler.** Over-cap submits *queue* rather than refuse and drain FIFO as
  slots free; a submit with no slot **and** a full queue is refused
  (`queue_full`); cancelling a queued task settles immediately without the cancel
  grace period; a fan-out up to the cap runs concurrently and stays bounded.
- **Queue TTL and deadlines.** A queued task expires at the queue TTL
  (`queue_ttl_exceeded`) without ever spawning a worker; a per-task `deadlineMs`
  expires a task that never got a slot; a deadline bounds a *running* turn and
  reports `deadline_exceeded` (rather than the much larger `timeoutMs`); a submit
  whose deadline already passed is refused outright.
- **Weighted fairness.** Default weights keep submit order exactly; a
  `weight: 3` profile takes 3 of the first 4 dispatch slots under contention.
- **Handoff (Phase 1).** The predecessor's result reaches the successor's prompt;
  a no-handoff control never sees it; the injected block is wrapped untrusted
  while the stored prompt stays original; a non-succeeded or unknown source is
  refused without spawning a worker; the artifact is capped to `maxBytes` and
  flagged `truncated`.

## `test/handoff.test.ts` — 12 cases

Redaction unit tests plus the Phase 2/3 behaviour, run against real temporary git
repositories (each test gets its own repo with one commit):

- **Redaction.** Known shapes are replaced and counted (`AKIA…`, `ghp_…`,
  `sk-ant-…`, `xoxb-…`, `Bearer …`, `password = "…"`); a whole PEM key block
  collapses to one marker; an assignment keeps its key name and separator; and
  ordinary code (`tokenize`, `token === undefined`, `timeoutMs: 30000`) is left
  untouched — no false positives on the shapes it claims to catch.
- **`inject: "diff"`.** A predecessor that edits a file produces a sidecar under
  `workdir/handoffs/<taskId>.diff`; the patch contains the file and the
  `[REDACTED:…]` markers but none of the raw secrets; the successor's stored
  prompt is still the original string; `metadata.handoff` carries the file/line
  counts and redaction total; a `handoff` event is recorded. A predecessor with a
  clean tree still succeeds and reports "no working-tree changes" (no sidecar).
  `maxBytes` truncates the artifact and flags `truncated`.
- **`base: "predecessor"`.** The successor's own worktree contains the
  predecessor's *uncommitted* file, while the predecessor's checkout keeps its
  commit count and its dirty status — the snapshot is built with plumbing against
  a temporary index, so it cannot disturb the predecessor. A `base: "repo"`
  control does not inherit the file. Without a worktree the combination is refused
  at admission (`handoff_base_requires_worktree`) and no worker is spawned; if the
  predecessor's worktree was killed, it fails with `handoff_base_unavailable`.
- **Remote successors.** A `base: "predecessor"` handoff is refused with
  `handoff_artifact_unavailable`, because the snapshot commit lives in the
  master's repository. A `diff` handoff is *not* refused — it is covered
  end-to-end in `test/artifact.test.ts`.

## `test/artifact.test.ts` — 7 cases

Cross-host diff handoff: the patch crosses the wire instead of being referenced
by a path the other machine cannot see.

- **End to end.** A mock predecessor writes a file containing secret-shaped
  strings in a worktree; a real loopback daemon receives the successor's submit
  with the patch attached, stages it under its own workdir, and runs the task.
  The test asserts the staged file exists at `<daemon workdir>/handoffs/<taskId>.diff`,
  that it matches the master's copy byte for byte, that the AWS key was redacted
  before shipping, and that the daemon-side prompt names the staged **absolute**
  path with no `{{artifact:}}` token left in it.
- **Ceiling.** A 4.2 MiB patch with `handoff.maxBytes` raised past the protocol
  limit fails the task with `handoff_artifact_too_large`, and nothing is staged on
  the daemon.
- **Receiver guards (unit, `stageArtifacts`).** A valid artifact is written under
  `<workdir>/handoffs/`; `../evil.diff`, `sub/evil.diff`, an absolute path and a
  non-`.diff` name are rejected (`artifact_invalid`); an oversized payload is
  rejected before any directory is created (`artifact_too_large`); a checksum
  mismatch and an empty payload are rejected (`artifact_checksum_mismatch`,
  `artifact_invalid`).
- **Version skew.** A fake daemon that announces protocol v1 is refused at the
  handshake (`protocol_mismatch`) instead of being sent a patch it would silently
  drop, leaving its agent with a literal `{{artifact:0}}` token.

## `test/paths.test.ts` — 3 cases

Whether two spellings of one directory name the same repository — the check that
decides if a `base: "predecessor"` successor may branch from the predecessor's
snapshot. A false negative refuses a valid handoff and blames the user's checkout
("is gone or not in the same repository") for something that is right there.

- **Linked worktree.** A `git worktree add` checkout and its main repo compare as
  one repository, in both directions.
- **Aliases.** A junction (Windows) or directory symlink (POSIX) pointing at a repo
  compares equal to the real path, so an 8.3 short name (`C:\Users\RUNNER~1\…`) or
  a `/private/var` style alias cannot produce a phantom mismatch. This is the
  regression test for the first Windows CI run, where two spellings of one
  directory made a valid handoff fail.
- **Negative cases.** Two distinct repos, a deleted directory, and a plain
  non-repository directory all report `false` — refusing those is the point.

## `test/contract.test.ts` — 10 cases

Result contracts and usage accounting, all through the Orchestrator with mock
workers whose replies are fixed strings.

- **Parsing units.** `extractJson` accepts a bare object, a fenced block, and JSON
  embedded in prose; it rejects prose-only text and the empty string. A `}` inside
  a string value does not end the scan early (the brace counter is
  string/escape-aware).
- **Contract satisfied.** A conforming reply settles `succeeded` with `structured`
  deep-equal to the parsed value, `metadata.outputContract.status = "ok"`, and the
  stored `prompt` still exactly what the master submitted (the schema is prompt
  payload, never persisted).
- **Tolerant extraction.** JSON wrapped in a sentence plus a ```` ```json ```` fence
  is still accepted.
- **`output_not_json`.** A prose reply fails the task with `retryable: true`, the
  raw text is still persisted (a failure you cannot read is undiagnosable), and
  `structured` stays absent.
- **`output_schema_invalid`.** Valid JSON that violates the schema fails with at
  least two validator errors and the offending JSON paths recorded.
- **The instruction reaches the worker.** A profile that fails whenever the prompt
  contains `OUTPUT CONTRACT` fails with a schema and succeeds without one — proving
  the block is really injected rather than merely noted in metadata.
- **`output_schema_too_large`.** A schema over 16 KiB is refused at submit with no
  worker spawned.
- **Latest-report-wins.** Three usage reports carrying running totals
  (100/200/300 input tokens) roll up to 300, not 600 — summing would
  multiply-count a cumulative counter.
- **Cost is a delta.** Two tasks on the *same* worker: the second reports 0.03, not
  the worker's cumulative 0.06.
- **`usage_summary`.** Aggregates tokens across tasks, keeps USD and CNY in
  separate buckets (never sums across currencies), filters by `profile`, and a
  future `since` cutoff selects nothing.

## `test/dag.test.ts` — 18 cases

Stage 5 advanced scheduling: `dependsOn` gating and per-task retries. Every case
drives submit → wait → record/events; the mock's `failFirst` knob (fail the
profile's first N turns *across workers*) is what makes a transient failure
observable without changing the prompt.

- **Gate then release.** A task with an unfinished dependency is accepted as
  `queued` with `dependsOn`/`blockedBy` and reported by `scheduler_status` under
  `blocked` (not `queued`); when the predecessor succeeds, a `dependency` event is
  recorded before `started` and `blockedBy` ends up empty.
- **Failure cascades.** A failed predecessor fails its dependent with
  `dependency_failed` and no worker spawned; a two-link chain (A→B→C) collapses
  completely, so nothing stays blocked.
- **Cancellation cascades.** Cancelling a dependency fails its dependents instead
  of stranding them; cancelling a *blocked* task settles immediately (no cancel
  grace period) and the predecessor finishing later does not resurrect it.
- **Admission refusals.** `dependency_unknown_task`; `dependency_failed` when the
  predecessor already settled badly; `dependency_limit_exceeded` past
  `maxDependencies`; `dependency_requires_queue` when `maxQueuedTasks` is `0`.
- **Capacity.** Blocked tasks count against `maxQueuedTasks`, so the next gated
  submit is refused with `queue_full` rather than piling up.
- **Deadline while blocked.** A deadline that elapses in the gate settles
  `timed_out` (`deadline_exceeded`) with no worker and no residue.
- **TTL starts at ready.** A 60ms `queueTtlMs` does not expire a task that waited
  ~200ms on its predecessor and then ran: waiting on a dependency is not queue
  starvation.
- **Retry exhaustion.** `retry: { maxAttempts: 3 }` produces three `started`
  events, two `retry` events, `attempt: 3`, `maxAttempts: 3`, and archives the two
  failed attempts (status/code) under `metadata.attempts`.
- **Recovery.** A transient first-turn failure succeeds on attempt 2, with the
  previous attempt's error cleared from the record.
- **Backoff.** With `delayMs: 80`, attempt 2 starts no earlier than the `retryAt`
  stamped on the retry event.
- **Spend across attempts.** Two metered attempts roll up to 2× tokens and 2× cost
  (each attempt really spent it) while the first attempt's own usage stays visible
  in `metadata.attempts[0].usage`; `usage_summary` agrees.
- **What is not retried.** Admission refusals (never reached a worker) skip the
  retry path; `onlyRetryable` also skips a `retryable: false` worker error;
  cancelling during the backoff settles `cancelled` and the pending attempt never
  starts; a deadline during the backoff settles `timed_out`.
- **Clamping.** `limits.maxRetryAttempts: 2` caps a `maxAttempts: 99` request.
- **Persistence.** `dependsOn`, `blockedBy`, `attempt`, `maxAttempts` and `retryAt`
  survive a SQLite round trip and an update to an empty `blockedBy`.

## `test/budget.test.ts` — 11 cases

Two guards on what a fan-out costs *while it runs*: approval width and spend.

- **Approval width.** With `limits.maxWaitingTasks: 1`, the first task parks on its
  permission request; the second is **denied on the spot** — it never enters
  `waiting`, no approval is queued for it, and the refusal is written to its
  timeline as an `approval_budget` event. Answering the first still resumes it
  normally. With no cap both park, which is the regression guard for the default.
- **Token ceiling.** A task reporting 1000 tokens against `budget.maxTokens: 100`
  settles `failed` / `budget_exceeded` / `retryable: false`, with
  `metadata.budget = { exceeded: true, totalTokens: 1000 }` — the record says what
  it actually spent, and the spend itself stays attached to the task.
- **Within budget.** 10 tokens against a 100 ceiling succeeds and carries no
  budget record at all.
- **Cost ceiling.** Applies in its own currency (0.5 USD against a 0.2 USD cap
  fails). Written in another currency it **does not apply**: the task succeeds and
  the timeline carries exactly one `budget_currency_mismatch` event.
- **One allowance per task, not per attempt.** A task with a 40-token ceiling that
  spends 30 and fails its first attempt is stopped on the second: the recorded
  total is 60, because the retry's spend was added to the first's rather than
  measured alone.
- **Overspending is never retried**, even with `retry.maxAttempts: 3`: the record
  stays at attempt 1 with no `metadata.attempts`.
- **Process ceilings.** After one 100-token task against
  `limits.maxTotalTokens: 50`, the next submit is refused synchronously with
  `budget_exhausted` and spawns no worker — while the task already accepted is
  left to finish.
- **Headroom is queryable.** `usage_summary().budget` starts at
  `{ exhausted: false, spentTokens: 0 }`, then reports 100 / exhausted / the
  reason string once the ceiling is crossed.
- **Currency isolation.** 10 USD of spend against a 0.1 CNY process ceiling leaves
  the budget open: `budget.spentCost` shows `[{ USD, 10 }]` and the next submit is
  admitted.

## `test/remote.test.ts` — 26 cases

Loopback daemon ↔ `RemoteWorkerDriver`, over a real HTTP + WebSocket server:

- **Round trips.** Dispatch completes and streams events back; approval
  (`waiting → approve → succeeded`); cancel drives the task to `cancelled`.
- **Auth.** A bad token is rejected at the WebSocket upgrade; `/healthz` is
  reachable without a token while `/profiles` is not; multiple valid tokens are
  accepted during a rotation; `reloadTokens()` rotates credentials with no restart
  and refuses an empty set.
- **Confinement.** The daemon refuses a working directory outside `allowCwd`;
  `assertSafeBind` refuses a non-loopback bind without TLS; `assertCwdAllowed`
  confines by path segment (not by string prefix).
- **Reconnect and reconciliation.** A completed task reconciles to its
  authoritative record; an unknown id resolves `undefined` (not an error); a
  dropped mid-run connection reconciles to `cancelled`, never a false `succeeded`.
- **Resumption.** `attach` resumes a dropped-but-grace task and streams it to
  success; `afterSequence` replays only newer events; attaching to an unknown task
  rejects; `runTurn` transparently re-attaches after a mid-run drop.
- **Conversations.** Two turns on one client-side worker keep ONE worker on the
  daemon (the session the master is talking to); two separate workers stay
  separate; an unknown `workerRef` is refused instead of silently starting over;
  a second turn while the first is running is refused (`worker_ref_busy`);
  `kill_worker` releases the daemon-side session.
- **Pinned sessions.** A `sessionKey` keeps one daemon worker across two separate
  connections (the ref cannot do that); a dead `workerRef` sent alongside a live
  `sessionKey` continues the conversation instead of failing; a `workerRef` paired
  with a different `sessionKey` is refused (`session_key_mismatch`).
- **Audit.** The daemon writes a structured NDJSON trail and never the token in
  cleartext.

The remote *security* model (flags, deployment shape, rotation drill) is documented
in [remote.md](remote.md#security-model); the coverage list above mirrors
[remote.md#remote-tests](remote.md#remote-tests).

## `test/team.test.ts` — 24 cases

The team layer, driven end-to-end over the mock harness (deterministic, offline)
plus a real HTTP server on an ephemeral port:

- **Mention parsing.** `a@dev.io` is not a mention; `@研发` is; repeated handles
  collapse; matching is case-insensitive.
- **The group chain.** One user message mentioning the CEO walks CEO → engineer →
  verifier; each reply is posted to the room, each `@mention` resolves to exactly
  one member, and three members end up with three live workers on three pinned
  sessions.
- **DM privacy and pull-in.** A DM stays out of `#general`; a teammate named in a
  DM is pulled into that thread and remains a participant; the DM never needs an
  explicit `@` for its own partner.
- **Serial per member, parallel across members.** Two messages to one member
  produce non-overlapping turns (the second starts after the first ends) and one
  worker; one message mentioning two members has both running at once.
- **The two caps.** A CEO↔engineer ping-pong stops at `maxHops` with a system line
  naming the cap; a three-way mention with `maxTurnsPerMessage: 1` queues only one
  turn and says why.
- **Restart recovery.** A queued turn survives a process stop and runs on the next
  start; the turn that was running is reported `interrupted` in the channel and is
  not replayed.
- **Approvals.** A member that hits a permission request is `waiting` (not
  running, not idle), the request is listed with its kind, and `approve` resumes
  the turn to `succeeded` without losing the member's queue slot.
- **Transparency.** `transcript` returns a member's turn with its task status and
  the event log behind it (tool/output events included), and a streaming member's
  twelve text deltas fold into one readable line while tool calls stay one per
  line.
- **Memory.** A `MEMORY.md` written by hand is injected into the next turn's prompt
  together with identity and role.
- **Pulses.** A member configured with `pulse` wakes on its own timer with no
  triggering message, is told its own cadence, and answering `SILENT` posts
  nothing at all; a pulse with something to say roots a fresh thread (so its
  `@mention` gets its own allowance) while the pulse turn itself belongs to no
  thread; an `idleOnly` member stays asleep while anyone works and wakes once the
  room is quiet; a member without `pulse` never wakes.
- **Console.** `GET /` returns the read-only page: `text/html`, a
  `default-src 'none'` CSP with `connect-src 'self'` and `frame-ancestors 'none'`,
  no `POST` anywhere in the document, and the team name escaped rather than
  interpolated. The shell loads without a token while every data endpoint behind
  it still answers 401, which is the point: a page anyone can open in a tab cannot
  reach a write route because the page has none. The inline script is compiled
  (not run) in the suite: the page is one template literal, and a stray backtick
  in it silently turns the rest of the document into code.
- **Forward migration.** A `team.sqlite` whose `turns` table still has
  `messageId NOT NULL` (the pre-pulse shape) opens, keeps its rows, defaults them
  to `message` turns, and continues its id sequence.
- **HTTP.** `/team` is 401 without a token and 200 with one, `/healthz` stays open,
  `POST /team/messages` runs the chain, paged messages and the per-member
  transcript round-trip.
- **Roster guards.** Two members claiming the same handle abort construction
  instead of making `@dev` ambiguous.
- **A member on another process.** A roster of three where the middle member is a
  `driver: remote` profile: the chain still walks CEO → engineer → verifier, the
  daemon-side task list holds exactly one `succeeded` task under the *daemon's*
  profile name, the local side holds exactly one proxied task, and the member
  keeps its ordinary `sessionKey` and transcript. The room never learns that one
  of its colleagues lives in a different process.
- **Session rotation.** With `sessionTurns: 2`, three turns of one member record
  keys `team:acme:dev`, `team:acme:dev`, `team:acme:dev#1` — per turn, in the
  store — and the roster reports the generation it is on now. Exactly one worker
  survives: the retired generation's process is closed, not left running. A
  restart reads the settled-turn count back out of SQLite, so the next turn
  resumes `#1` instead of rewinding to the base key; the room gets one system
  line per rotation so a member that "forgot" reads as a fresh session rather
  than a defect.

A real mixed-harness team run (pi + opencode in one room) is **not** part of the
suite — it needs logged-in agents and spends tokens. It was run by hand; see
[Beyond the unit suite](#beyond-the-unit-suite). The session-resume mechanism a
member relies on is verified separately in `test/orchestrator.test.ts`.

## `test/deploy.test.ts` — 8 cases

The deployment path: what only breaks once the daemon leaves loopback. Uses the
committed throwaway certificates in `test/fixtures/tls/` (a trusted CA and an
unrelated one), so it needs no `openssl` and no network.

- **TLS material resolution.** Inline PEM passes through; a path is read from
  disk; a missing path or a non-PEM file raises `tls_invalid` at the point of
  configuration instead of as an opaque handshake failure on the peer.
- **mTLS required.** With `daemon.tls.ca` set, a master that presents no client
  certificate fails before the submit handler runs — asserted both by the failed
  turn and by the daemon having admitted **zero** tasks — and the refusal appears
  in the audit trail as `tls_reject`.
- **mTLS accepted / foreign CA rejected.** A client certificate signed by the
  daemon's CA completes the task; one signed by the other CA is refused.
- **Untrusted server certificate.** A master trusting CA A refuses a daemon
  serving a certificate from CA B (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`).
- **Plaintext guard.** Constructing a daemon on `0.0.0.0` without TLS throws
  `insecure_bind` even when a token is configured.
- **Audit rotation.** With `maxBytes`/`keep`, the log rotates, keeps exactly the
  configured number of archives, and the retained records tile a *contiguous*
  sequence — rotation drops the oldest data, never a record in the middle.
  `maxBytes: 0` never rotates; `auditPath: ""` yields a no-op sink.
- **Config surface.** `daemon.auditMaxBytes` / `auditKeep` parse.

The same path driven over a *real interface* (not loopback) is `npm run
deploy:tls`; it is a script rather than a test because it needs `openssl` and a
non-internal IPv4 address, which a hermetic suite cannot assume.

## `test/orchestrator.test.ts` — 11 cases

The synchronous façade: dispatch spawns a worker and completes the loop; a spawned
worker is reusable for follow-ups via `workerId`; events surface as task output
events; a failing worker reports `failed`; `kill_worker` removes it from the
registry; `listProfiles` reflects config.

Pinned sessions at the same layer: spawning twice under one `sessionKey` attaches
to the live worker instead of starting a second; different keys stay separate; a
profile-level `session` applies with no per-spawn key; a pinned session refuses
`worktree`; attaching while the conversation is mid-turn is refused (`is busy`)
rather than queued.

## `test/skill.test.ts` — 4 cases

The self-hosted master playbook: `findPackageRoot` locates the package;
`readSkill` returns both languages' markdown from disk; an in-memory MCP client
confirms the server exposes `master_playbook` (`en`/`zh`) and serves the same text
as browsable resources.

## Beyond the unit suite

- `npm run demo` — Scene A (sync dispatch to two workers) and Scene B
  (`submit → waiting → approve → succeeded`) both close.
- `npm run smoke` — a real MCP stdio server driven through the full lifecycle;
  event sequence `accepted, started, output…, waiting, resumed, output…, completed`.
- `agentmesh daemon` boot check — `/healthz` open, `/profiles` 401 without a token
  and 200 with `Authorization: Bearer …`, clean SIGINT shutdown.
- `npm run real` — **real local OpenCode and Pi** driven through
  `task_submit → task_wait → task_result`; both return `OK`, reach `succeeded`, and
  persist their tasks + events to SQLite (2 tasks / 27 events observed).
- `npm run deploy:tls` — the daemon bound to `0.0.0.0` on this host's **LAN
  address** with a freshly generated CA, driven by a real `RemoteWorkerDriver`
  over `https://<lan-ip>:<port>`: 9/9 checks — plaintext bind refused, task
  completes over TLS, the daemon observes the peer on that address, wrong CA
  refused, mTLS without a certificate refused, mTLS with one completes. Run on
  Windows with address `192.168.110.27`.
- **Pinned session against real `pi`** (ad-hoc run, not part of `npm test` because
  it needs a logged-in agent and spends tokens). Turn one told pi to remember
  `417`; the daemon was stopped; a new daemon was started from the same `workdir`;
  turn two on the same `sessionKey` asked for the number and pi answered `417`.
  The ACP session id was byte-identical across the restart. This exercises the
  three things the unit suite can only mock: the session record on disk, acpx's
  `resume` path, and the client's `sessionKey` wire field.
- **A mixed-harness room** (ad-hoc run, 2026-10-20, not in `npm test`: it needs
  logged-in agents and spends tokens). Three members, two harnesses: CEO on **pi**,
  engineer on **opencode**, verifier on **pi**. One message walked the chain; the
  engineer wrote `greet.mjs` with its own tools, the verifier ran it with `node` and
  quoted the output plus the file's md5. Seven messages (six from members) and six
  member turns, every turn `succeeded` — no harness-specific code anywhere in the
  team layer. The run
  also produced the finding now written into `team.md`: mentions **fan out**, so
  naming the verifier in the same reply as the builder started verification before
  the file existed; the verifier honestly reported `ERR_MODULE_NOT_FOUND`, and the
  chain only converged when the engineer's own message re-raised the mention.
- **Session rotation against real `pi`** (ad-hoc run, 2026-10-20, not in `npm test`:
  it spends tokens). `sessionTurns: 1`, three turns: keys `team:rotate:pi`,
  `…:pi#1`, `…:pi#2` — and the third ran after the server was stopped and
  restarted, so the generation comes from SQLite, not from process memory. Each
  turn answered `417` because the number was written to `MEMORY.md` in turn one;
  the conversation itself was genuinely new each time (the room printed the
  "starting a fresh session" line twice). Rotation is only safe because the room
  and the memory file are the continuity — this is that claim, checked against a
  real adapter rather than a mock.

## Known gaps

Honest limits of the evidence above — these are not covered by the suite yet:

- **macOS.** CI covers Linux and Windows only; nothing here has been run on
  Darwin, where `node:sqlite`, the `ws` TLS stack and git are all the same but
  path handling and the default shell are not.
- **Two physical machines.** The TLS path is verified on one host over its real
  interface, with a real certificate chain and mTLS; what remains unexercised is
  distance — DNS, routing, and the worker's firewall (`docs/deploy.md` covers the
  checklist, but no run has crossed a physical link).
- **Concurrent processes sharing one SQLite file.** Two processes *can* open the
  same DB safely (`busy_timeout` + WAL), but the suite tests this incidentally
  rather than as a documented multi-writer contract.
- **Concurrent editors on one repo.** Worktree isolation is verified, but two
  workers editing the *same* worktree concurrently is not.
- **Cost and usage are only as good as the adapter.** The roll-up is exercised
  against the mock's usage reports and the ACP `usage_update` mapping is
  type-checked against `acpx`, but no real adapter's cost figure has been asserted
  end-to-end here — and adapters differ in what they report (Claude Code attaches a
  per-turn breakdown; others send only a cumulative cost, or nothing). Missing
  fields therefore mean "unknown", never zero.
- **Long-running soak.** Queueing and fairness are tested as unit scenarios, not
  as a multi-hour soak.
- **Cross-host artifacts are loopback-only so far.** Diff handoffs do cross the
  wire now (verified against a real daemon on 127.0.0.1), but not yet over a
  physical link or through TLS/mTLS; a single artifact is capped at 4 MiB by the
  protocol frame, and `base: "predecessor"` stays single-host because a commit
  object is not a byte payload.
- **Redaction is a safety net, not a scanner.** It catches well-known key shapes
  and `key = value` assignments; a secret with no recognisable shape passes
  through, so the artifact is still untrusted data.
- **Handoff sidecars are not garbage-collected.** They accumulate under
  `<workdir>/handoffs/` (one per diff handoff); pruning is left to the operator.
- **Retry and dependency state live in memory.** A restart preserves the records
  (and their `attempt`/`blockedBy` columns) but does not rehydrate the scheduler:
  queued, blocked and backoff-waiting tasks stay where they are, exactly like
  queued tasks before this change. Each retried attempt also gets its own worker
  (and worktree, when the profile isolates edits), which is only cleaned up when
  the worker is killed or the orchestrator shuts down.
