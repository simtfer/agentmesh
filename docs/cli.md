# CLI and attaching a master

Two ways to drive agentmesh from outside: the CLI for demos and one-shot work, and
an MCP client (`mcp` mode) for real orchestration.

## Contents

- [Commands](#commands)
- [Team commands](#team-commands)
- [Attach a real master](#attach-a-real-master)
- [One-shot vs resident](#one-shot-vs-resident)

## Commands

```bash
npx tsx src/cli.ts demo
npx tsx src/cli.ts list     --config agentmesh.yaml
npx tsx src/cli.ts mcp      --config agentmesh.yaml

# synchronous delegate-and-wait
npx tsx src/cli.ts dispatch --profile pi --task "fix the auth bug" --worktree

# async task lifecycle (persisted to SQLite)
npx tsx src/cli.ts submit   --profile pi --prompt "fix the auth bug"   # prints taskId
npx tsx src/cli.ts tasks    --config agentmesh.yaml

# run workers on another machine (see remote.md)
npx tsx src/cli.ts daemon   --config agentmesh.yaml --host 127.0.0.1 --port 8790 \
  --token-env AGENTMESH_DAEMON_TOKEN
```

| command | what it does |
|---|---|
| `demo` | Scene A (sync delegate-and-wait) + Scene B (submit → waiting → approve → succeeded), using mocks |
| `list` | configured profiles, drivers and their defaults |
| `mcp` | serve the orchestrator over stdio MCP — the mode a real master attaches to |
| `dispatch` | submit and wait for the terminal result in one call |
| `submit` | submit async, print the `taskId`, exit |
| `tasks` | list persisted tasks from the store |
| `daemon` | run the Worker Daemon for cross-machine workers |

**Task approvals have no one-shot CLI subcommand.** A pending approval lives in
the orchestrator that owns the running task; a second process holding the same
SQLite file cannot answer it, so `agentmesh approve` would either lie or hang. Use
the MCP surface (`task_approve`, or `task_pending_approvals` to list them) from the
same process that submitted the task — that is the master agent's job. (A team is
different: `team serve` owns the approvals, so `team approve` reaches the process
that can actually resolve one.)

## Attach a real master

Build, then point your master agent's MCP config at the server. The command is
always: `node <abs>/dist/cli.js mcp --config <abs>/agentmesh.yaml`.

```bash
npm run build
```

**Claude Code** (project `.mcp.json`, or `claude mcp add`) — the configuration
used throughout [`quickstart.md`](./quickstart.md) and
[`two-host.md`](./two-host.md):

```json
{
  "mcpServers": {
    "agentmesh": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABS/PATH/agentmesh/dist/cli.js", "mcp", "--config", "/ABS/PATH/agentmesh/agentmesh.yaml"],
      "env": { "AGENTMESH_REMOTE_TOKEN": "${AGENTMESH_REMOTE_TOKEN}" }
    }
  }
}
```

```bash
claude mcp add --scope user --transport stdio agentmesh -- \
  node /ABS/PATH/agentmesh/dist/cli.js mcp --config /ABS/PATH/agentmesh/agentmesh.yaml
claude mcp list          # a server that exits immediately shows up as failed
```

`${VAR}` is expanded by Claude Code, so the token stays in the shell. Absolute
paths are not optional: the server is spawned from Claude Code's cwd.

**OpenCode** (`opencode.json` / `~/.config/opencode/opencode.json`) — shape:

```json
{
  "mcp": {
    "agentmesh": {
      "type": "local",
      "command": ["node", "/ABS/PATH/agentmesh/dist/cli.js", "mcp", "--config", "/ABS/PATH/agentmesh/agentmesh.yaml"],
      "enabled": true
    }
  }
}
```

**Pi** (`.pi/settings.json` or `~/.pi/agent/settings.json`) — Pi 1.0 has native
MCP; add agentmesh as a local/stdio MCP server with the same command.

> Verify the exact MCP-server config keys against the current OpenCode/Pi docs —
> the command line above is what matters and is stable.

Then just talk to your master: *"have the pi worker on B add a `/health`
endpoint and run its tests"* (or *"spawn an opencode worker here while pi writes
the changelog"*). It calls `dispatch_task`.

## One-shot vs resident

> `submit` from the one-shot CLI persists the task, but its live run ends with the
> process. For real async use, submit through the long-lived `mcp` server (or a
> resident orchestrator) so the run continues in the background.

This is the single most common false alarm — a task that looks "stuck" after
`cli submit` is usually a task whose process is already gone. See
[`troubleshooting.md`](./troubleshooting.md).

## Team commands

`team serve` is the resident process; every other `team` command is a client of
its JSON API, so they can run from another terminal (or another machine, with
`--url` and a token).

```bash
# host: owns the roster and its agent sessions
npx tsx src/cli.ts team serve --config agentmesh.yaml --port 4317

# client (default target http://127.0.0.1:4317, token from AGENTMESH_TEAM_TOKEN)
npx tsx src/cli.ts team chat
npx tsx src/cli.ts team say general "Ship /health this week. @ceo, take it." --wait
npx tsx src/cli.ts team dm qa "Any risk before we ship?" --wait
npx tsx src/cli.ts team log general --limit 20 [--follow]
npx tsx src/cli.ts team members | channels | status
npx tsx src/cli.ts team board [channel]      # work nobody was named in
npx tsx src/cli.ts team transcript dev --limit 5
npx tsx src/cli.ts team pulse ceo            # wake one member now (same guards as its timer)
npx tsx src/cli.ts team approve <approvalId> allow_once
npx tsx src/cli.ts team respond <approvalId> accept --content '{"answer":"yes"}'
```

| command | what it does |
|---|---|
| `serve` | load `team:`, start members lazily, serve the API and the read-only console at `/`; SIGINT/SIGTERM drains |
| `chat` | interactive room: plain text goes to `#general`, `/dm <member>`, `/log`, `/status`, `/transcript` |
| `say` / `dm` | post a message; `--wait` follows the thread until the team is quiet (or blocked on an approval) |
| `log` | the room transcript, including system notices; `--follow` tails it |
| `status` | per-member state, queue depth, live worker, channels, pending approvals, and how much is waiting on the board — or expired off it after the room passed |
| `board` | messages the user posted without naming anyone: who has what, what is still open, who passed, and how old it is; expired items are listed separately underneath |
| `transcript` | one member's turns **with the task events behind them** (tool calls, waiting, failures); streamed deltas are folded into one line |
| `pulse` | wake one member by hand; refuses (and says so) while the room is busy |
| `approve` | resolve a permission request blocking a turn (`allow_once`, `reject_always`, …) |
| `respond` | answer an elicitation (`accept` / `decline` / `cancel`, optional `--content` JSON) |

`team chat` is the only place where the client prints a prompt, so it is the one to
use interactively; everything else is pipe-friendly plain text. Full semantics:
[`team.md`](./team.md).
