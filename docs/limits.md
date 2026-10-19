# Safety and limits

Every guard agentmesh applies to a delegation, local or remote, and what each one
costs you when it fires. The front page keeps the summary; this file is the
reference.

Remote-specific security — token auth, zero-downtime key rotation, the cwd
whitelist, TLS and the audit trail — lives in [`remote.md`](./remote.md#security-model).

## Contents

- [Untrusted worker output](#untrusted-worker-output)
- [Recursion guard](#recursion-guard)
- [Resource limits](#resource-limits)
- [Scheduler back-pressure](#scheduler-back-pressure)
- [Queue TTL and deadlines](#queue-ttl-and-deadlines)
- [Weighted fair queueing](#weighted-fair-queueing)
- [Dependencies (`dependsOn`)](#dependencies-dependson)
- [Retries (`retry`)](#retries-retry)
- [Spend budgets](#spend-budgets)
- [Approval width](#approval-width)
- [Process ceilings](#process-ceilings)

## Untrusted worker output

Everything a worker returns — result text, permission requests, elicitation
prompts, and any handoff artifact — is treated as **data to act on, never as
instructions to obey**. Handoff injections are wrapped in a `trusted=NO` envelope
for exactly this reason. Run untrusted work at `permissionMode:
approve-reads`/`deny-all` and require human approval for irreversible operations.

## Recursion guard

A master is itself an agent, so a delegation chain (or a master↔worker loop) could
recurse forever. `limits.maxDelegationDepth` (default 8) caps it: agentmesh reads
its own level from `$AGENTMESH_DELEGATION_DEPTH` (0 for a top-level master) and
injects level+1 into every agent it spawns, so a nested agentmesh inherits the
chain depth across process boundaries. A submit whose effective depth reaches the
cap fails with `delegation_depth_exceeded` *without spawning a worker*; a
caller-stamped depth can only raise it, never lower the inherited base.

## Resource limits

Two further guards bound the blast radius of a busy or runaway master.

- `limits.maxConcurrentTasks` (default unlimited) caps how many tasks may run at
  once.
- `limits.maxOutputBytes` (default 1 MiB) caps the result text persisted per task:
  a larger result is truncated on a UTF-8 boundary (never splitting a multibyte
  codepoint), the record is flagged `outputTruncated`, and a truncation note is
  recorded as an event so the clip is observable rather than silent.
- `limits.maxHandoffBytes` (default 256 KiB) caps how much of a predecessor's
  result a cross-worker handoff may inject into a successor prompt, using the same
  UTF-8-safe clip.

## Scheduler back-pressure

What happens to a submit that arrives while every slot is busy is governed by
`limits.maxQueuedTasks`. Left at `0` (the default), the submit is refused
immediately with `concurrency_limit_exceeded` *without spawning a worker* — pure
back-pressure, so a fan-out burst can't exhaust the host.

Set it `>0` to turn on real scheduling: over-cap submits park in a bounded queue
and drain automatically as running tasks settle, and only a submit that finds the
queue full too is refused (`queue_full`). A single queue owner (`pump()`) advances
the queue whenever a slot frees, so admission stays race-free under a same-tick
burst. A queued task holds no worker and can be cancelled — it settles at once
instead of waiting out the cancel grace period. The `scheduler_status` MCP tool
exposes running vs queued counts, the configured caps, and the queue in dispatch
order so a master can read back-pressure before fanning out.

## Queue TTL and deadlines

`limits.queueTtlMs` caps how long a task may *wait*: on expiry it leaves the queue
and settles `timed_out` with `queue_ttl_exceeded`, never having spawned a worker.

A per-task deadline is stronger — `task_submit { deadlineMs }` (budget from submit)
or `{ deadlineAt }` (absolute epoch ms) covers queue wait **and** execution, so a
slow backlog can't quietly blow a wall-clock commitment: the task settles
`timed_out` with `deadline_exceeded` whether it was still queued or already
running, and a deadline already past at submit time is refused outright. The run
timer fires at the *smaller* of the task's `timeoutMs` and the deadline remainder,
so the two budgets compose instead of fighting.

## Weighted fair queueing

With the default profile weight of `1` the queue is strict FIFO (submit order ==
dispatch order). Give a profile a `weight` and the scheduler switches to weighted
fair queueing with finish tags
(`tag = max(pass[profile], virtualTime) + 1/weight`): a `weight: 3` profile gets
roughly three dispatch slots per one of a `weight: 1` profile under contention,
while virtual time advances on *service*, so a late arrival cannot jump a backlog
on a stale tag. Weights only reorder *waiting* work — they never let more than
`maxConcurrentTasks` run.

## Dependencies (`dependsOn`)

A task may name other tasks that must settle `succeeded` before it is allowed to
start. It is accepted immediately as `queued` with a `blockedBy` list, stays out of
the dispatch queue (so it never consumes a slot or distorts queue order), and
enters the queue the moment its last dependency succeeds.

A dependency that ends any other way fails the dependent with `dependency_failed`
— *without spawning a worker* — and that failure cascades down the chain, so a
broken DAG collapses instead of stranding a tail of tasks. `blockedBy` also clears
on cancellation. Gated tasks count against `maxQueuedTasks` (they are accepted work
waiting for the scheduler), so `dependsOn` requires `maxQueuedTasks > 0` and
refuses with `dependency_requires_queue` otherwise. Queue TTL starts when the task
becomes *ready*; a per-task deadline still covers the whole wait.

## Retries (`retry`)

Opt-in per task: `{ maxAttempts, delayMs, backoff, maxDelayMs, onlyRetryable }`.

A failed or timed-out attempt that actually ran is re-queued (after the backoff)
instead of settling, up to `maxAttempts` total runs — the record never touches a
terminal state in between, so `task_wait` spans every attempt and dependents keep
waiting. Admission refusals (queue full, depth exceeded, bad handoff, …) are never
retried: they never reached a worker. Each attempt gets a fresh
worker/AbortController, the failed ones are archived under `metadata.attempts`
(status, error, timing, spend, a bounded text preview), and token/cost totals are
**summed across attempts** because every attempt really spent them.
`limits.maxRetryAttempts` (default 5) clamps what a caller may ask for.

## Spend budgets

A wall-clock budget bounds *time*; this bounds *money* — the failure a deadline
does not catch, since an agent can finish in two seconds and still burn a fortune.

`{ maxTokens, maxCost }` is checked on every usage report, so a breach aborts the
turn mid-flight instead of surfacing afterwards in `usage_summary`. It counts **all
attempts** (a retry gets no fresh allowance — the money is gone either way),
settles `failed` with `budget_exceeded`, and is **never retried**. A cost ceiling
only applies to reports in the same currency; a mismatch is recorded once as
`budget_currency_mismatch` and otherwise ignored, because comparing 0.02 USD
against 0.02 CNY would be a unit error rather than a limit.

## Approval width

`limits.maxWaitingTasks` bounds how many tasks may block on an approval at once.
Past it, a permission request is **denied on the spot** rather than parked: the
worker carries on without that tool, and the refusal is written to the task's
timeline as an `approval_budget` event. A fan-out that queues a hundred unanswered
questions is not making progress — it is spending concurrency slots on questions
nobody is reading.

## Process ceilings

Once the running roll-up crosses `limits.maxTotalTokens` or `limits.maxTotalCost`,
new submits are refused with `budget_exhausted`; work already accepted runs to its
end, because cancelling it would lose the result without refunding the spend.
`usage_summary` reports the headroom (`budget.exhausted`, `budget.spentTokens`), so
a master can check *before* launching the next batch instead of discovering it when
it is refused.

## Putting it together

```jsonc
// B runs only after A and C both succeeded; a dead A/C fails B immediately.
task_submit({ "prompt": "…", "profile": "pi", "dependsOn": ["<taskA>", "<taskC>"] })
// Same task, retried up to 3 times with 0.5s/1s backoff before it gives up.
task_submit({ "prompt": "…", "profile": "pi",
              "retry": { "maxAttempts": 3, "delayMs": 500, "backoff": "exponential" } })
// Stop this task the moment it passes 50k tokens or $0.20.
task_submit({ "prompt": "…", "profile": "pi",
              "budget": { "maxTokens": 50000, "maxCost": { "amount": 0.2, "currency": "USD" } } })
```

All three are opt-in per task; with none of these fields the behaviour is unchanged
(start as soon as a slot is free, settle on the first failure).
