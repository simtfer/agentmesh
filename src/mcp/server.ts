import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Orchestrator } from "../orchestrator.js";
import { readSkill, skillResourceUri, SKILL_LANGS, type SkillLang } from "../skill.js";

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
 * Cross-worker handoff (Phase 1). Only `inject: "result"` and `base: "repo"` are
 * supported today; the enums are narrow so a master asking for a not-yet-built
 * mode (`diff` / `predecessor`) gets a clear schema error rather than a silent
 * no-op. `maxBytes` optionally overrides `limits.maxHandoffBytes` per task.
 */
const handoffSchema = z.object({
  fromTaskId: z.string(),
  inject: z.enum(["result", "diff"]).optional(),
  base: z.enum(["repo", "predecessor"]).optional(),
  maxBytes: z.number().int().positive().optional(),
});

/**
 * Per-task spend ceiling. Omitted = only wall-clock limits apply. Enforced on
 * every usage report: a breach aborts the turn and settles the task
 * `failed` (`budget_exceeded`), counted across all attempts and never retried.
 */
const budgetSchema = z.object({
  maxTokens: z.number().int().positive().optional(),
  maxCost: z
    .object({
      amount: z.number().nonnegative(),
      currency: z.string().optional(),
    })
    .optional(),
});

/**
 * Automatic retry (Stage 5). Opt-in: omit it and a task settles on its first
 * failure. `maxAttempts` counts total runs including the first, and is clamped by
 * `limits.maxRetryAttempts`; admission refusals are never retried.
 */
const retrySchema = z.object({
  maxAttempts: z.number().int().positive().max(100).optional(),
  delayMs: z.number().int().nonnegative().optional(),
  backoff: z.enum(["fixed", "exponential"]).optional(),
  maxDelayMs: z.number().int().nonnegative().optional(),
  onlyRetryable: z.boolean().optional(),
});

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
        sessionKey: z
          .string()
          .optional()
          .describe(
            "Pin this worker to a stable conversation key. Re-spawning with the same key resumes the stored conversation (also after a restart) instead of starting a new one. Cannot be combined with worktree, and only one live worker may hold a key.",
          ),
      },
    },
    wrap(async ({ profile, cwd, worktree, sessionKey }) => {
      const workerId = await orch.spawnWorker(profile, { cwd, worktree, sessionKey });
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
        "Submit a task and return immediately with a taskId. The task runs in the background; poll task_status / task_wait, or stream task_events. Reuse a worker via workerId or spawn one from profile. Optionally chain off a predecessor via `handoff` to inject its result as untrusted context, gate the task on other tasks via `dependsOn` (DAG), and retry transient failures via `retry`.",
      inputSchema: {
        prompt: z.string(),
        profile: z.string().optional(),
        workerId: z.string().optional(),
        sessionKey: z
          .string()
          .optional()
          .describe(
            "Run this task in a pinned conversation, spawning a worker bound to it if none is live. The agent keeps its context across tasks that share the key. Ignored when workerId is given.",
          ),
        cwd: z.string().optional(),
        worktree: z.boolean().optional(),
        timeoutMs: z.number().int().positive().optional(),
        deadlineMs: z.number().int().positive().optional(),
        deadlineAt: z.number().int().positive().optional(),
        idempotencyKey: z.string().optional(),
        handoff: handoffSchema.optional(),
        outputSchema: z.record(z.unknown()).optional(),
        dependsOn: z
          .array(z.string())
          .optional()
          .describe(
            "Task IDs that must settle `succeeded` before this task starts. A dependency that fails fails this task (`dependency_failed`). Needs limits.maxQueuedTasks > 0.",
          ),
        retry: retrySchema.optional(),
        budget: budgetSchema.optional(),
      },
    },
    wrap(({ prompt, profile, workerId, sessionKey, cwd, worktree, timeoutMs, deadlineMs, deadlineAt, idempotencyKey, handoff, outputSchema, dependsOn, retry, budget }) =>
      orch.submitTask({
        prompt,
        profile,
        workerId,
        sessionKey,
        cwd,
        worktree,
        timeoutMs,
        deadlineMs,
        deadlineAt,
        idempotencyKey,
        handoff,
        outputSchema,
        dependsOn,
        retry,
        budget,
      }),
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
        // Present only when the task ran under an `outputSchema` contract and
        // satisfied it — a violated contract fails the task instead.
        structured: t.structured,
        stopReason: t.stopReason,
        error: t.error,
        workerId: t.workerId,
        usage: t.usage,
        contract: t.metadata?.outputContract,
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

  server.registerTool(
    "usage_summary",
    {
      title: "Token and cost roll-up",
      description:
        "Roll up token usage and cost across tasks, optionally filtered by profile and start time. Only tasks whose worker reported usage are counted in `reporting`; costs are grouped by currency and never summed across currencies. The `budget` block reports headroom against `limits.maxTotalTokens` / `maxTotalCost` for this process, so check it before launching a batch rather than discovering `budget_exhausted` on the next submit.",
      inputSchema: {
        profile: z.string().optional(),
        since: z.number().int().positive().optional(),
      },
    },
    wrap(({ profile, since }) => orch.usageSummary({ profile, since })),
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
        sessionKey: z.string().optional(),
        cwd: z.string().optional(),
        worktree: z.boolean().optional(),
        deadlineMs: z.number().int().positive().optional(),
        handoff: handoffSchema.optional(),
        outputSchema: z.record(z.unknown()).optional(),
        dependsOn: z.array(z.string()).optional(),
        retry: retrySchema.optional(),
        budget: budgetSchema.optional(),
      },
    },
    wrap(async ({ task, workerId, profile, sessionKey, cwd, worktree, deadlineMs, handoff, outputSchema, dependsOn, retry, budget }) => {
      const r = await orch.dispatch({ task, workerId, profile, sessionKey, cwd, worktree, deadlineMs, handoff, outputSchema, dependsOn, retry, budget });
      return r;
    }),
  );

  /* ---------------------- master skill (self-hosted) --------------------- */
  //
  // agentmesh ships its own MASTER delegation playbook and serves it over MCP,
  // so a connected master can load "how to delegate well" without anyone
  // copy-pasting a prompt into each agent's config. Two channels, same on-disk
  // source of truth (skills/agentmesh-master/SKILL*.md):
  //   • a tool  — universally callable; every MCP client supports tools.
  //   • resources — browsable via resources/list + resources/read.
  // The tool returns the markdown as raw text content (not JSON-wrapped) so the
  // master receives clean, injectable prose.

  server.registerTool(
    "master_playbook",
    {
      title: "Master delegation playbook",
      description:
        "Load the agentmesh MASTER skill: how to decompose work, pick profiles, fan out asynchronously with backpressure, handle approvals/failures, and treat worker output as untrusted data. Read this once before your first delegation. lang: 'en' (default) or 'zh'.",
      inputSchema: { lang: z.enum(["en", "zh"]).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ lang }) => {
      const r = await readSkill((lang ?? "en") as SkillLang);
      if (!r.ok) {
        return { content: [{ type: "text" as const, text: `# agentmesh master skill unavailable\n\n${r.error}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: r.markdown }] };
    },
  );

  for (const lang of SKILL_LANGS) {
    server.registerResource(
      `master-skill-${lang}`,
      skillResourceUri(lang),
      {
        title: `agentmesh Master Playbook (${lang.toUpperCase()})`,
        description:
          "The self-hosted MASTER delegation skill: decompose, delegate async, respect backpressure, gate irreversible actions, treat worker output as untrusted.",
        mimeType: "text/markdown",
      },
      async (uri) => {
        const r = await readSkill(lang);
        const text = r.ok ? r.markdown : `# agentmesh master skill unavailable\n\n${r.error}`;
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
      },
    );
  }

  return server;
}

export async function runMcpServer(orch: Orchestrator): Promise<void> {
  const server = createMcpServer(orch);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[agentmesh] MCP server ready on stdio\n");
}
