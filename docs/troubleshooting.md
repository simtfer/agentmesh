# Troubleshooting

Every failure lands on the task record (`error.code`) *and* the event log, so
`task_result` / `task_events` tell you **why**, not just that it failed.

## Contents

- [Error codes](#error-codes)
- [Symptoms that aren't error codes](#symptoms-that-arent-error-codes)
- [Where to look next](#where-to-look-next)

## Error codes

| `error.code` | What happened | What to do |
|---|---|---|
| `concurrency_limit_exceeded` | every slot busy and `maxQueuedTasks` is `0` | retry after one settles, or set `maxQueuedTasks > 0` to queue instead of refuse |
| `queue_full` | slots busy **and** the queue is at `maxQueuedTasks` | raise `maxQueuedTasks` or submit smaller batches; `scheduler_status` shows the backlog |
| `queue_ttl_exceeded` | waited longer than `queueTtlMs` without ever starting | raise `queueTtlMs`, add capacity, or split the batch |
| `dependency_unknown_task` | `dependsOn` names a task that does not exist (a task under another `workdir` is invisible) | fix the id |
| `dependency_failed` | a dependency settled `failed`/`cancelled`/`timed_out`, so this task can never run | fix or re-run the upstream task; the message names the culprit |
| `dependency_requires_queue` | `dependsOn` used with `maxQueuedTasks: 0` (nowhere to hold a gated task) | set `limits.maxQueuedTasks > 0` |
| `dependency_limit_exceeded` | more entries in `dependsOn` than `limits.maxDependencies` (default 16) | split the fan-in or raise the cap |
| `deadline_exceeded` | hit its `deadlineMs`/`deadlineAt` — while queued **or** running | give it a bigger budget; if it never started, that's a capacity problem, not a task problem |
| `task_timeout` | the run exceeded `timeoutMs` (no deadline involved) | raise `timeoutMs` for long turns |
| `budget_exceeded` | the task passed its own `budget` (tokens and/or cost) | raise the ceiling or split the work; it is never retried |
| `budget_exhausted` | the process has spent `limits.maxTotalTokens` / `maxTotalCost`; new submits are refused | raise the ceiling or start a fresh process; accepted work still finishes |
| `interrupted` | a resident process (`team serve`, the remote daemon) started and found this task left `queued`/`starting`/`running`/`waiting` by the previous one | nothing was replayed and nothing will finish it — resubmit. A task recorded as `queued` never ran, so resubmitting is safe; one that was `running` may already have edited files, so check the tree first |
| `delegation_depth_exceeded` | the chain reached `maxDelegationDepth` | usually a master delegating in a loop — inspect the chain before raising the cap |
| `handoff_unknown_task` | `handoff.fromTaskId` matches no stored task | check the id; a task under another `workdir` is invisible |
| `handoff_predecessor_not_ready` | the predecessor is not `succeeded` yet | `task_wait` on it first; failed/cancelled output is never handed off |
| `handoff_base_requires_worktree` | `base: "predecessor"` without a worktree | pass `worktree: true` or enable it on the profile |
| `handoff_base_unavailable` | the predecessor's checkout is gone or in another repo | keep its worker alive until the successor starts |
| `handoff_artifact_unavailable` | `base: "predecessor"` targets a remote worker, or the predecessor's checkout vanished | use `inject: "diff"` with `base: "repo"`, or run the successor locally |
| `handoff_artifact_too_large` | a remote `diff` handoff exceeds the 4 MiB artifact ceiling | lower `handoff.maxBytes`, split the change, or run the successor locally |
| `output_not_json` | `outputSchema` was set but the reply contains no parseable JSON | restate the contract in the task ("reply with JSON only"); `retryable`, so re-running is reasonable |
| `output_schema_invalid` | the reply parsed but violates the schema | read `metadata.outputContract.errors` for the offending paths — usually one field the prompt never pinned down |
| `output_schema_too_large` | the schema exceeds 16 KiB | trim descriptions/examples; the schema goes into the prompt |

## Symptoms that aren't error codes

- **A task sits in `waiting` and nothing happens.** It is blocked on a permission
  or elicitation request — call `pending_approvals`, then `task_approve` /
  `task_respond`. `task_wait` returns as soon as this occurs, by design.
- **`dispatch_task` appears to hang.** It waits for a terminal state, so a task
  that needs approval can never advance inside it. Use `task_submit` +
  `task_wait` when human intervention is possible.
- **`cli submit` exits and the task never progresses.** Expected: the one-shot
  CLI's live run ends with the process. Use the long-lived `mcp` server for real
  async work (also called out in [`cli.md`](./cli.md)).
- **A remote submit fails with `artifact_invalid`, `artifact_too_large` or
  `artifact_checksum_mismatch`.** The daemon refused a handoff artifact before
  creating a task: the name was not a bare `*.diff`, the decoded size was over
  4 MiB, or the bytes did not match the SHA-256 the master sent. Nothing was
  written to disk. These arrive as a submission error (the task record shows
  `exception` with the code in the message), which means the client and daemon
  disagree — check versions first. A `protocol_mismatch` in that message means the
  daemon predates artifact staging: upgrade it, or run the successor locally.
- **Daemon refuses the connection or returns 401.** Bind/TLS/token rules are in
  [`remote.md`](./remote.md#security-model); the token must come from the
  environment named by `--token-env`.
- **A remote task fails with a TLS error** (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`,
  `CERT_HAS_EXPIRED`, `altname`, `alert certificate required`, `ECONNRESET`
  immediately after connecting). These are certificate problems, not agent
  problems — the table in [`deploy.md`](./deploy.md#7-troubleshooting) maps each
  one to its cause and fix.

## Where to look next

| Symptom area | Reference |
|---|---|
| Why a submit was refused before it ran | [`limits.md`](./limits.md) — the guard behind each code |
| Task never reaches a terminal state | [`lifecycle.md`](./lifecycle.md) — states, approvals, retries |
| Handoff or contract failures | [`handoff.md`](./handoff.md), [`contracts.md`](./contracts.md) |
| Remote connection, auth, TLS | [`remote.md`](./remote.md), [`deploy.md`](./deploy.md) |
| What the suite actually covers | [`verification.md`](./verification.md) |
