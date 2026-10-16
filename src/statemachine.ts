import type { TaskStatus } from "./types.js";
import { TERMINAL_TASK_STATUSES } from "./types.js";

/**
 * Legal task-state transitions. Terminal states cannot be left.
 * `waiting` is NOT terminal — it must resume to running or settle.
 */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  queued: ["starting", "cancelled", "failed"],
  starting: ["running", "waiting", "failed", "cancelled", "timed_out"],
  running: ["waiting", "succeeded", "failed", "cancelled", "timed_out"],
  waiting: ["running", "succeeded", "failed", "cancelled", "timed_out"],
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
