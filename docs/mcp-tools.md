# MCP tools exposed to the master

The adapter's inbound surface: 18 tools over stdio, plus the self-hosted master
playbook. Anything that speaks MCP can attach and become a master without changes
to itself.

## Contents

- [Tools](#tools)
- [Master playbook (self-hosted)](#master-playbook-self-hosted)

## Tools

| tool | purpose |
|---|---|
| `agent_list` | configured worker profiles + live workers |
| `agent_inspect` | one worker's status + recent event log |
| `spawn_worker` | start a worker (optionally in a git worktree); `sessionKey` pins it to a named conversation that a later spawn with the same key attaches to |
| `kill_worker` | close a worker and clean its worktree |
| `task_submit` | **submit a task, return a `taskId` immediately** (primary async call); `workerId` runs the turn on an existing worker — and on a remote worker that means the same agent session, i.e. a continuous conversation; `sessionKey` does the same by name, and survives a restart; `deadlineMs`/`deadlineAt` bound queue wait + execution; `dependsOn` gates it behind other tasks; `retry` re-runs transient failures; optional `handoff` chains onto a finished task; `outputSchema` enforces a JSON result contract |
| `task_status` | current status of a task |
| `task_wait` | block until terminal **or** `waiting` (needs approval) |
| `task_result` | final text / status / error of a task, plus `structured` (contract result), `usage` (tokens/cost) and `contract` (verdict) |
| `task_events` | persisted event log after a sequence number |
| `task_cancel` | request cancellation (settles once the worker confirms) |
| `list_tasks` | list tasks, optionally filtered by status |
| `scheduler_status` | running vs queued vs dependency-blocked counts, configured caps (`maxQueuedTasks`, `queueTtlMs`), the queue in dispatch order, and per-entry weight / wait / time-to-expiry |
| `usage_summary` | token/cost roll-up across tasks (`profile`, `since` filters), costs grouped by currency, plus `budget` headroom (`exhausted`, `spentTokens`, `maxTotalTokens`) against the process ceilings |
| `pending_approvals` | approval/elicitation requests blocking a `waiting` task |
| `task_approve` | resolve a permission request (allow/deny/cancel) |
| `task_respond` | answer an elicitation request |
| `dispatch_task` | synchronous convenience: submit + wait for the terminal result |
| `master_playbook` | load the self-hosted MASTER delegation skill (`lang`: `en`/`zh`) |

Semantics behind the task tools — states, deadlines, retries, handoff, contracts —
are in [`lifecycle.md`](./lifecycle.md), [`limits.md`](./limits.md),
[`handoff.md`](./handoff.md) and [`contracts.md`](./contracts.md).

## Master playbook (self-hosted)

Giving a master the tools only tells it what it *can* do — not how to delegate
*well*. agentmesh ships a **master playbook** and serves it over MCP, so the
guidance travels with the server instead of being hand-pasted into every agent.

- **Source of truth:** `skills/agentmesh-master/SKILL.md` (English) and
  `SKILL.zh.md` (中文). Standard skill layout with YAML frontmatter, so the same
  files also work as a drop-in skill for agents that load skills from disk.
- **Served two ways:** the `master_playbook` tool (universally callable — every
  MCP client supports tools; `lang` selects `en`/`zh`) and two browsable
  resources, `agentmesh://skills/master/en` and `agentmesh://skills/master/zh`.
- **Resolved at runtime** from the agentmesh package root, so it works both from
  source (`tsx src/cli.ts mcp`) and from the built/installed binary
  (`node dist/cli.js mcp`); `skills/` is included in the published package.

The playbook covers the five rules (async-first, worker output is untrusted data,
look before you delegate, backpressure is a signal, stop for humans on the
irreversible), the delegation loop, an intent→tool cheat-sheet, how to write a
self-contained subtask prompt, anti-patterns, and the security red lines that
mirror agentmesh's own guarantees. A master should call `master_playbook` once
before its first fan-out.
