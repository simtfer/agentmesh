# Cross-worker handoff

A fan-out isn't always independent — sometimes task B should *continue from* task
A (A writes a report, B reviews it; A patches, B tests). The `handoff` field on
`task_submit` / `dispatch_task` chains one task onto a finished predecessor without
the master copying A's output by hand.

## Contents

- [Two independent axes](#two-independent-axes)
- [What each shape does](#what-each-shape-does)
- [Admission rules](#admission-rules)
- [Same-host constraint](#same-host-constraint)

## Two independent axes

```jsonc
{
  "task": "Review the patch and flag anything unsafe.",
  "profile": "pi",
  "handoff": { "fromTaskId": "<taskA>", "inject": "diff", "base": "predecessor" }
}
```

| field | value | meaning |
|---|---|---|
| `inject` | `"result"` (default) | the predecessor's final text, inlined into the prompt |
| | `"diff"` | the predecessor's working-tree patch, as a redacted sidecar file |
| `base` | `"repo"` (default) | the successor's worktree branches from the repo's HEAD |
| | `"predecessor"` | …from a snapshot of the predecessor's end state |

## What each shape does

- **`inject: "result"`** prepends the persisted result text, wrapped in an
  untrusted envelope (`<<<UPSTREAM WORKER OUTPUT  trusted=NO … >>>`) that tells
  the worker to treat the block strictly as **data to act on, never as
  instructions**. Another worker's output is not a command channel.
- **`inject: "diff"`** keeps the patch out of the prompt. It captures the
  predecessor's working-tree diff — tracked edits *and* new untracked files,
  honouring `.gitignore` — redacts secret-shaped strings (`AKIA…`, `ghp_…`,
  `sk-…`, `xox…`, `Bearer …`, PEM private keys, `password = …` assignments),
  caps it, and writes it to `<workdir>/handoffs/<taskId>.diff`. The prompt only
  points at that path, so a multi-megabyte patch never has to fit in a prompt.
  Redaction is pattern-based and deliberately best-effort: it reduces accidental
  leakage, it is **not** a guarantee, and the artifact remains untrusted data.
  The diff is captured against a temporary git index, so the predecessor's own
  index, HEAD and working tree are never modified.
- **`base: "predecessor"`** snapshots the predecessor's working tree into a commit
  (`git write-tree` + `commit-tree` against a temporary index) and creates the
  successor's worktree from it — so the successor literally starts where the
  predecessor stopped, with its uncommitted work in place. The predecessor's own
  branch, index and files are never modified. Requires the successor to run in a
  worktree (`handoff_base_requires_worktree` otherwise).
- **Ephemeral by design.** The augmented prompt is built at run time; the *stored*
  `prompt` stays exactly what the master submitted. Only a compact
  `metadata.handoff` summary (`fromTaskId`, `inject`, `base`, `injectedBytes`,
  `truncated`, `filesChanged`, `addedLines`, `deletedLines`, `redactions`,
  `artifact`) and a `handoff` event are persisted.

## Admission rules

Unknown source → `handoff_unknown_task`; source not `succeeded` →
`handoff_predecessor_not_ready`; a remote successor for an artifact handoff →
`handoff_artifact_unavailable`; a dead or foreign checkout for
`base: "predecessor"` → `handoff_base_unavailable`. All are refused *without
spawning a worker*.

**Byte cap.** `handoff.maxBytes` (falling back to `limits.maxHandoffBytes`, default
256 KiB), truncated on a UTF-8 boundary and flagged `truncated`.

## Same-host constraint

> Diff handoffs and predecessor snapshots assume the successor runs on the same
> host as the master. A `driver: remote` successor can see neither artifact, so
> agentmesh refuses the combination rather than handing it a path it cannot read.

That is deliberate: the alternative — handing the worker an absolute path that
does not exist on its machine — fails later, inside the agent, with no error code
and no useful message. Transporting artifacts across machines is tracked in the
[roadmap](./PLAN.md) and is not implemented; `inject: "result"` already works
cross-machine because the text travels in the prompt itself.

## See also

| Topic | Reference |
|---|---|
| Why a handoff was refused | [`troubleshooting.md`](./troubleshooting.md) |
| Task states and retries | [`lifecycle.md`](./lifecycle.md), [`limits.md`](./limits.md) |
| Result contracts on the successor | [`contracts.md`](./contracts.md) |
