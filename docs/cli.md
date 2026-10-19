# CLI and attaching a master

Two ways to drive agentmesh from outside: the CLI for demos and one-shot work, and
an MCP client (`mcp` mode) for real orchestration.

## Contents

- [Commands](#commands)
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

**Approvals have no CLI subcommand.** A pending approval lives in the orchestrator
that owns the running task; a second process holding the same SQLite file cannot
answer it, so `agentmesh approve` would either lie or hang. Use the MCP surface
(`task_approve`, or `task_pending_approvals` to list them) from the same process
that submitted the task — that is the master agent's job.

## Attach a real master

Build, then point your master agent's MCP config at the server. The command is
always: `node <abs>/dist/cli.js mcp --config <abs>/agentmesh.yaml`.

```bash
npm run build
```

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

Then just talk to your master: *"spawn an opencode worker to fix the failing
tests while a pi worker writes the changelog."* It will call `dispatch_task`.

## One-shot vs resident

> `submit` from the one-shot CLI persists the task, but its live run ends with the
> process. For real async use, submit through the long-lived `mcp` server (or a
> resident orchestrator) so the run continues in the background.

This is the single most common false alarm — a task that looks "stuck" after
`cli submit` is usually a task whose process is already gone. See
[`troubleshooting.md`](./troubleshooting.md).
