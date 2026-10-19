# Task lifecycle

Every delegation is a **task** in a persistent state machine. The front page keeps
the diagram; this file is the reference for states, transitions, delegating modes
and the approval loop.

## Contents

- [The 8-state machine](#the-8-state-machine)
- [Two ways to delegate](#two-ways-to-delegate)
- [Approvals (human-in-the-loop)](#approvals-human-in-the-loop)
- [See also](#see-also)

## The 8-state machine

```
queued ─▶ starting ─▶ running ─▶ succeeded
                        │  ▲
                 waiting│  │ (approve / respond)
                        ▼  │
                       (loops back to running)
   queued (no slot, TTL/deadline hit) ─▶ timed_out         (terminal)
   starting/running/waiting ─▶ queued        (retry: another attempt is due)
   running/waiting ─▶ failed | cancelled | timed_out   (terminal)
```

Terminal states: `succeeded`, `failed`, `cancelled`, `timed_out`. Tasks and their
event logs are persisted to **SQLite** (`node:sqlite`, no native deps) under
`workdir`, so a task submitted by one process can be queried by the next.

Transitions are enforced in one place (`src/statemachine.ts`): an illegal move is
rejected rather than written, and every transition is an event with a sequence
number, which is what makes `task_events { afterSequence }` and a reconnecting
remote master safe to use.

## Two ways to delegate

- **Async (primary):** `task_submit` returns a `taskId` immediately. Poll
  `task_status`, block on `task_wait`, read `task_result`, or page `task_events`.
  `task_wait` also returns as soon as a task enters `waiting` so the master can
  act on an approval instead of blocking to the timeout.
- **Sync (convenience):** `dispatch_task` submits and waits for the terminal
  result in one call.

## Approvals (human-in-the-loop)

When a worker hits a risky tool (ACP permission request) or asks for input (ACP
elicitation), its task moves to `waiting` and blocks. The master then:

1. `pending_approvals { taskId? }` → lists blocking requests (`kind`, `id`).
2. `task_approve { approvalId, decision }` → `allow_once | allow_always |
   reject_once | reject_always | cancel`, **or**
   `task_respond { approvalId, action, content? }` → answer an elicitation.

Approving resumes the task synchronously back to `running`; rejecting fails it.
Cancelling or timing out a task auto-resolves its pending approvals.

Approval safety properties worth knowing:

- A pending approval **never** blocks a slot forever: the task's `timeoutMs` /
  deadline still applies, and cancelling settles the outstanding request.
- Approval width is capped by `limits.maxWaitingTasks`; past it a request is
  denied on the spot and recorded as an `approval_budget` event — see
  [`limits.md`](./limits.md#approval-width).
- A remote master drives the same loop over the daemon's `approve`/`respond`
  frames; a dropped connection reconciles the task instead of leaving it blocked
  (see [`remote.md`](./remote.md#reconnect--reconciliation)).

> **Security:** worker output and permission requests are **untrusted data**, never
> instructions. Keep `permissionMode` at `approve-reads`/`deny-all` for untrusted
> work, require human approval for irreversible operations, and never commit
> secrets or expose the ACP bridge to a network without auth + TLS.

## See also

| Topic | Reference |
|---|---|
| Queueing, TTL, deadlines, retries, budgets | [`limits.md`](./limits.md) |
| Chaining a task onto a finished one | [`handoff.md`](./handoff.md) |
| Machine-consumable results | [`contracts.md`](./contracts.md) |
| The full tool list | [`mcp-tools.md`](./mcp-tools.md) |
