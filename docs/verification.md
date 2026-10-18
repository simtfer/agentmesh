# Verification

What agentmesh's test suite actually covers, and how to re-run it yourself.
This is the detailed counterpart to the short [Verification](../README.md#verification)
section in the README; keep the per-case lists here so the front page stays readable.

## Environment

| | |
|---|---|
| OS | Windows — the only platform the suite has actually been run on; CI on Linux/macOS is not wired up yet |
| Node | v22.22 (`engines: >=22.13`; `node:sqlite` is built in, no native deps) |
| Network | not required — every test uses mocks or a loopback daemon |
| Cost | zero — no model API is called unless you run `npm run real` |

## Reproduce

```bash
npm run typecheck   # tsc --noEmit, clean
npm test            # 82 tests, offline, ~22s
npm run demo        # Scene A + Scene B, ends with "Scene A CLOSED ✅ | Scene B CLOSED ✅"
npm run smoke       # real MCP server over stdio through the full lifecycle
npm run real        # real local opencode + pi workers (needs both installed & authenticated)
```

`npm test` runs the six files below with `tsx --test`. Nothing is skipped, nothing
is marked `todo`, and no test asserts a mock's internal calls in place of
observable behaviour — each one drives the public surface (Orchestrator, MCP
tools, or the daemon's HTTP/WS endpoints) and checks the resulting task record.

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
- **Remote successors.** Both artifact handoffs are refused with
  `handoff_artifact_unavailable`, because the sidecar and the snapshot live on the
  master's filesystem.

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

## `test/remote.test.ts` — 18 cases

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
- **Audit.** The daemon writes a structured NDJSON trail and never the token in
  cleartext.

The remote *security* model (flags, deployment shape, rotation drill) is documented
in [remote.md](remote.md#security-model); the coverage list above mirrors
[remote.md#remote-tests](remote.md#remote-tests).

## `test/orchestrator.test.ts` — 6 cases

The synchronous façade: dispatch spawns a worker and completes the loop; a spawned
worker is reusable for follow-ups via `workerId`; events surface as task output
events; a failing worker reports `failed`; `kill_worker` removes it from the
registry; `listProfiles` reflects config.

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

## Known gaps

Honest limits of the evidence above — these are not covered by the suite yet:

- **Real two-machine deployment.** The daemon is verified over loopback only;
  a genuine cross-host run with a real certificate chain is not part of the suite.
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
- **Diff handoffs are single-host.** A remote successor is refused rather than
  shipped a sidecar it cannot read; there is no artifact transfer over the daemon
  protocol yet.
- **Redaction is a safety net, not a scanner.** It catches well-known key shapes
  and `key = value` assignments; a secret with no recognisable shape passes
  through, so the artifact is still untrusted data.
- **Handoff sidecars are not garbage-collected.** They accumulate under
  `<workdir>/handoffs/` (one per diff handoff); pruning is left to the operator.
