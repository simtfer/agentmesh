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
npm test            # 60 tests, offline, ~8s
npm run demo        # Scene A + Scene B, ends with "Scene A CLOSED ✅ | Scene B CLOSED ✅"
npm run smoke       # real MCP server over stdio through the full lifecycle
npm run real        # real local opencode + pi workers (needs both installed & authenticated)
```

`npm test` runs the four files below with `tsx --test`. Nothing is skipped, nothing
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
  `deadlineAt` column on open.
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
- **Cost and usage.** ACP `usage_update` events are not yet rolled up or asserted.
- **Long-running soak.** Queueing and fairness are tested as unit scenarios, not
  as a multi-hour soak.
