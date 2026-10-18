import type { TaskStatus } from "./types.js";
import { TERMINAL_TASK_STATUSES } from "./types.js";

/**
 * Legal task-state transitions. Terminal states cannot be left. `waiting` is NOT
 * terminal — it must resume to running or settle.
 *
 * `→ queued` from a non-queued state is the *retry* path: a failed or timed-out
 * attempt with attempts left is re-admitted to the queue instead of settling, so
 * the record never actually lands on the terminal state (see TaskManager's
 * retry intercept). `attempt` / `retryAt` record that it is a later attempt.
 */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  // queued → timed_out is legal: a task can expire in the queue (TTL or deadline)
  // before it ever gets a slot, and it must still reach a terminal state.
  queued: ["starting", "cancelled", "failed", "timed_out"],
  starting: ["queued", "running", "waiting", "failed", "cancelled", "timed_out"],
  running: ["queued", "waiting", "succeeded", "failed", "cancelled", "timed_out"],
  waiting: ["queued", "running", "succeeded", "failed", "cancelled", "timed_out"],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true; // idempotent no-op
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal task transition: ${from} -> ${to}`);
  }
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}
