import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Orchestrator } from "../orchestrator.js";

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const wrap =
  (fn: (args: any) => unknown | Promise<unknown>) =>
  async (args: any) => {
    try {
      return json(await fn(args ?? {}));
    } catch (e) {
      return fail(e);
    }
  };

/**
 * Expose the orchestrator as MCP tools. Any MCP-capable agent (opencode, pi,
 * claude, ...) that connects becomes a "master" able to submit tasks to and
 * command heterogeneous workers — with zero changes to the master itself.
 */
export function createMcpServer(orch: Orchestrator): McpServer {
  const server = new McpServer({ name: "agentmesh", version: "0.2.0" });

  /* ---------------------------- agents ---------------------------- */

  server.registerTool(
    "agent_list",
    {
      title: "List agents",
      description: "List configured worker profiles and currently live workers.",
      inputSchema: {},
    },
    wrap(() => ({ profiles: orch.listProfiles(), workers: orch.listWorkers() })),
  );

  server.registerTool(
    "agent_inspect",
    {
      title: "Inspect a worker",
      description: "Get a worker's status and recent event log.",
      inputSchema: { workerId: z.string(), recentEvents: z.number().int().min(0).max(200).optional() },
    },
    wrap(({ workerId, recentEvents }) => {
      const w = orch.getWorker(workerId, recentEvents ?? 20);
      if (!w) throw new Error(`no such worker: ${workerId}`);
      return w;
    }),
  );

  server.registerTool(
    "spawn_worker",
    {
      title: "Spawn a worker",
      description: "Start a worker of the given profile without assigning a task yet.",
      inputSchema: {
        profile: z.string(),
        cwd: z.string().optional(),
        worktree: z.boolean().optional(),
      },
    },
    wrap(async ({ profile, cwd, worktree }) => {
      const workerId = await orch.spawnWorker(profile, { cwd, worktree });
      return { workerId, ...(orch.getWorker(workerId) ?? {}) };
    }),
  );

  server.registerTool(
    "kill_worker",
    {
      title: "Kill a worker",
      description: "Close a worker and remove its worktree if any.",
      inputSchema: { workerId: z.string() },
    },
    wrap(async ({ workerId }) => {
      await orch.killWorker(workerId);
      return { killed: workerId };
    }),
  );

  /* ----------------------------- tasks ---------------------------- */

  server.registerTool(
    "task_submit",
    {
      title: "Submit a task (async)",
      description:
        "Submit a task and return immediately with a taskId. The task runs in the background; poll task_status / task_wait, or stream task_events. Reuse a worker via workerId or spawn one from profile.",
      inputSchema: {
        prompt: z.string(),
        profile: z.string().optional(),
        workerId: z.string().optional(),
        cwd: z.string().optional(),
        worktree: z.boolean().optional(),
        timeoutMs: z.number().int().positive().optional(),
        idempotencyKey: z.string().optional(),
      },
    },
    wrap(({ prompt, profile, workerId, cwd, worktree, timeoutMs, idempotencyKey }) =>
      orch.submitTask({ prompt, profile, workerId, cwd, worktree, timeoutMs, idempotencyKey }),
    ),
  );

  server.registerTool(
    "task_status",
    {
      title: "Task status",
      description: "Get the current status of a task.",
      inputSchema: { taskId: z.string() },
    },
    wrap(({ taskId }) => {
      const t = orch.taskStatus(taskId);
      if (!t) throw new Error(`no such task: ${taskId}`);
      return t;
    }),
  );

  server.registerTool(
    "task_wait",
    {
      title: "Wait for a task",
      description:
        "Block until the task reaches a terminal state or the wait times out. If the task is `waiting`, it needs approval — see pending_approvals. Returns the (possibly non-terminal) record.",
      inputSchema: { taskId: z.string(), timeoutMs: z.number().int().positive().optional() },
    },
    wrap(async ({ taskId, timeoutMs }) => {
      const t = await orch.waitTask(taskId, timeoutMs ?? 120000);
      if (!t) throw new Error(`no such task: ${taskId}`);
      return { terminal: ["succeeded", "failed", "cancelled", "timed_out"].includes(t.status), task: t };
    }),
  );

  server.registerTool(
    "task_result",
    {
      title: "Task result",
      description: "Get the final result text, status and error of a task.",
      inputSchema: { taskId: z.string() },
    },
    wrap(({ taskId }) => {
      const t = orch.taskResult(taskId);
      if (!t) throw new Error(`no such task: ${taskId}`);
      return {
        taskId: t.taskId,
        status: t.status,
        text: t.text,
        stopReason: t.stopReason,
        error: t.error,
        workerId: t.workerId,
      };
    }),
  );

  server.registerTool(
    "task_events",
    {
      title: "Task event log",
      description: "Get persisted task events after a sequence number (paged stream).",
      inputSchema: { taskId: z.string(), afterSequence: z.number().int().min(0).optional() },
    },
    wrap(({ taskId, afterSequence }) => ({ events: orch.taskEvents(taskId, afterSequence ?? 0) })),
  );

  server.registerTool(
    "task_cancel",
    {
      title: "Cancel a task",
      description: "Request cancellation. The task is only marked cancelled after the worker confirms.",
      inputSchema: { taskId: z.string() },
    },
    wrap(async ({ taskId }) => {
      const t = await orch.cancelTask(taskId);
      return t ?? { taskId, status: "not_found" };
    }),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description: "List tasks, optionally filtered by status.",
      inputSchema: {
        status: z
          .enum(["queued", "starting", "running", "waiting", "succeeded", "failed", "cancelled", "timed_out"])
          .optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    wrap(({ status, limit }) => ({ tasks: orch.listTasks({ status, limit }) })),
  );

  server.registerTool(
    "scheduler_status",
    {
      title: "Scheduler status",
      description:
        "Introspect the task scheduler: how many tasks are running vs waiting in the FIFO queue, the configured concurrency/queue caps, and the current queue order. Useful to see backpressure before submitting a fan-out.",
      inputSchema: {},
    },
    wrap(() => orch.schedulerStatus()),
  );

  /* --------------------------- approvals -------------------------- */

  server.registerTool(
    "pending_approvals",
    {
      title: "Pending approvals",
      description: "List approval/elicitation requests blocking a `waiting` task.",
      inputSchema: { taskId: z.string().optional() },
    },
    wrap(({ taskId }) => ({ approvals: orch.pendingApprovals(taskId) })),
  );

  server.registerTool(
    "task_approve",
    {
      title: "Approve/deny a permission request",
      description: "Resolve a pending permission request so a waiting task can continue.",
      inputSchema: {
        approvalId: z.string(),
        decision: z.enum(["allow_once", "allow_always", "reject_once", "reject_always", "cancel"]),
      },
    },
    wrap(({ approvalId, decision }) => ({ resolved: orch.approveTask(approvalId, decision) })),
  );

  server.registerTool(
    "task_respond",
    {
      title: "Answer an elicitation",
      description: "Resolve a pending elicitation (agent asked for input) for a waiting task.",
      inputSchema: {
        approvalId: z.string(),
        action: z.enum(["accept", "decline", "cancel"]),
        content: z.record(z.unknown()).optional(),
      },
    },
    wrap(({ approvalId, action, content }) => ({
      resolved: orch.respondTask(approvalId, { action, content: content ?? null }),
    })),
  );

  /* --------------------- convenience (sync) ---------------------- */

  server.registerTool(
    "dispatch_task",
    {
      title: "Delegate a task and wait",
      description: "Synchronous convenience: submit a task and wait for its terminal result.",
      inputSchema: {
        task: z.string(),
        workerId: z.string().optional(),
        profile: z.string().optional(),
        cwd: z.string().optional(),
        worktree: z.boolean().optional(),
      },
    },
    wrap(async ({ task, workerId, profile, cwd, worktree }) => {
      const r = await orch.dispatch({ task, workerId, profile, cwd, worktree });
      return r;
    }),
  );

  return server;
}

export async function runMcpServer(orch: Orchestrator): Promise<void> {
  const server = createMcpServer(orch);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[agentmesh] MCP server ready on stdio\n");
}
