# Structured results and cost

Free-form prose is fine for a human reader and useless for a program. Two opt-in
features make a fan-out machine-consumable: an enforced **JSON result contract**
and a **token/cost roll-up**.

## Contents

- [Result contracts](#result-contracts)
- [Cost and usage roll-up](#cost-and-usage-roll-up)

## Result contracts

```jsonc
{
  "task": "Extract the failing test names as JSON.",
  "profile": "pi",
  "outputSchema": {
    "type": "object",
    "required": ["tests"],
    "properties": { "tests": { "type": "array", "items": { "type": "string" } } },
    "additionalProperties": false
  }
}
```

The schema is appended to the worker's prompt as a `OUTPUT CONTRACT (enforced)`
block — last, so it reads as the final formatting rule — asking for one raw JSON
value and nothing else. When the turn finishes, agentmesh parses the reply and
validates it:

- **Parsing is tolerant, validation is not.** Agents fence or pad their JSON even
  when told not to, so the parser tries the whole reply, then a ```` ```json ````
  block, then the first balanced `{…}` / `[…]` region. Nothing parseable →
  `output_not_json`.
- **A violation fails the task.** `output_schema_invalid` carries up to ten
  validator errors with their JSON paths in `error.message` and
  `metadata.outputContract.errors`. The offending text is still stored, because a
  failure you cannot see is worse than one you can.
- **`structured` is the payoff.** On success `task_result` returns the parsed value
  in `structured` (and `task_status` carries it on the record), so a master can
  read a list, a table or a boolean verdict without re-parsing prose.
- **The schema is prompt, not data.** It must serialize to ≤ 16 KiB
  (`output_schema_too_large` otherwise) and it is never persisted on the task —
  only the parsed value and a compact `metadata.outputContract` verdict.
- Keywords are evaluated with **draft-07 semantics** (ajv); a `$schema` naming
  another draft is ignored rather than treated as a hard error.

## Cost and usage roll-up

Workers that report usage (ACP `usage_update`, e.g. Claude Code) feed a per-task
record in `usage`:

```jsonc
{
  "inputTokens": 1200, "outputTokens": 340, "cachedReadTokens": 800,
  "cost": { "amount": 0.0123, "currency": "USD" },
  "contextUsed": 12000, "contextSize": 200000, "reports": 4
}
```

Two decisions matter here:

- **Latest report wins, not the sum.** ACP reports the *current state* of the
  session — token counts are per-turn totals and cost is cumulative — so folding
  every report in by addition would multiply-count. Each new report replaces the
  previous one.
- **Cost is a delta.** Reusing a worker via `workerId` means its cumulative cost
  already includes earlier tasks; agentmesh remembers the baseline at turn start
  and attributes only the difference to this task. (A counter that goes backwards
  — an adapter restart — is treated as a per-turn figure instead.)

`usage_summary` aggregates across tasks, filtered by `profile` and `since`.
Costs are grouped by currency and never summed across currencies. Absent fields
mean "the agent never reported it", not zero — adapters differ in what they emit.

Retries complicate the picture in one specific way: token/cost totals are summed
**across attempts** (every attempt really spent them), while `contextUsed` stays a
snapshot of the latest turn. Spend ceilings are described in
[`limits.md`](./limits.md#spend-budgets).
