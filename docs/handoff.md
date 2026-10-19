# Cross-worker handoff

A fan-out isn't always independent — sometimes task B should *continue from* task
A (A writes a report, B reviews it; A patches, B tests). The `handoff` field on
`task_submit` / `dispatch_task` chains one task onto a finished predecessor without
the master copying A's output by hand.

## Contents

- [Two independent axes](#two-independent-axes)
- [What each shape does](#what-each-shape-does)
- [Admission rules](#admission-rules)
- [Cross-host handoff](#cross-host-handoff)
- [What still stays on one host](#what-still-stays-on-one-host)

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
  index, HEAD and working tree are never modified. For a remote successor the
  same bytes are also shipped with the submit — see
  [Cross-host handoff](#cross-host-handoff).
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
`handoff_predecessor_not_ready`; a remote successor using `base: "predecessor"` →
`handoff_artifact_unavailable`; a dead or foreign checkout for
`base: "predecessor"` → `handoff_base_unavailable`; a remote patch larger than
4 MiB → `handoff_artifact_too_large`. All are refused *without spawning a
worker*.

**Byte cap.** `handoff.maxBytes` (falling back to `limits.maxHandoffBytes`, default
256 KiB), truncated on a UTF-8 boundary and flagged `truncated`.

## Cross-host handoff

`inject: "diff"` works with a `driver: remote` successor. The patch is bytes, so
it travels with the submit instead of being referenced by a path the other host
cannot see:

1. The master captures and redacts the diff exactly as it does locally, and keeps
   its own copy at `<master workdir>/handoffs/<taskId>.diff`.
2. The same bytes are attached to the submit frame (base64 + SHA-256).
3. The daemon stages them in **its own** state dir, `<daemon workdir>/handoffs/`,
   after checking the name, the size and the checksum — never in the task's
   working directory, which may be any whitelisted repo on that host.
4. The prompt refers to the file as `{{artifact:0}}`; the daemon rewrites that
   token to the absolute staged path before the task is submitted, so the agent
   gets a path that exists on *its* machine.

The token is the contract, and it exists because the master genuinely cannot know
a path on the worker's host — inventing one would fail later, inside the agent,
with no error code and no useful message.

**Ceiling:** one artifact is capped at **4 MiB** raw (`MAX_HANDOFF_ARTIFACT_BYTES`)
so its base64 frame fits the 8 MiB protocol payload. `limits.maxHandoffBytes`
defaults to 256 KiB and is the real limit in practice; raising it past 4 MiB only
moves the failure to `handoff_artifact_too_large`, which fails the task *before*
anything is sent rather than shipping half a patch.

**Version skew:** this needs daemon protocol **v2**. A v1 daemon would ignore the
attachment and leave the agent holding a literal `{{artifact:0}}`, so the client
refuses at the handshake (`protocol_mismatch`) instead of shipping a prompt that
cannot work.

**Trust:** the staged file is still untrusted data — same envelope, same warning.
The receiver only proves that the bytes arrived intact (SHA-256), not that they
are safe or complete. Files are written with mode 0600.

## What still stays on one host

`base: "predecessor"` is refused for a remote successor
(`handoff_artifact_unavailable`). A commit object is not a byte payload: it lives
in the master's git object database, and the successor's worktree can only branch
from it if the daemon's checkout reaches the same object. Shipping a `git bundle`
would work only when both sides share a base commit; otherwise the merge is
undefined. The honest options today are `inject: "diff"` with `base: "repo"`, or
running the successor locally.

## See also

| Topic | Reference |
|---|---|
| Why a handoff was refused | [`troubleshooting.md`](./troubleshooting.md) |
| Task states and retries | [`lifecycle.md`](./lifecycle.md), [`limits.md`](./limits.md) |
| Result contracts on the successor | [`contracts.md`](./contracts.md) |
