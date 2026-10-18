import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await run("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--is-inside-work-tree"], dir);
    return true;
  } catch {
    return false;
  }
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseRepo: string;
}

/** Absolute path of the repository's common git dir (shared by all its worktrees). */
export async function gitCommonDir(dir: string): Promise<string | undefined> {
  try {
    const out = await git(["rev-parse", "--git-common-dir"], dir);
    return path.resolve(dir, out);
  } catch {
    return undefined;
  }
}

/**
 * Create an isolated git worktree so parallel workers never touch the same
 * files. Branch + path are derived from the worker id.
 *
 * `fromCommit` starts the branch at an arbitrary commit instead of the repo's
 * HEAD — that is how handoff `base: "predecessor"` gives a successor the
 * predecessor's exact end state (a snapshot commit built by `snapshotWorktree`).
 */
export async function createWorktree(
  baseRepo: string,
  workerId: string,
  workdir: string,
  opts: { fromCommit?: string } = {},
): Promise<WorktreeInfo> {
  if (!(await isGitRepo(baseRepo))) {
    throw new Error(
      `worktree requested but "${baseRepo}" is not inside a git repository`,
    );
  }
  const branch = `agentmesh/${workerId}`;
  const wtPath = path.join(workdir, "worktrees", workerId);
  await mkdir(path.dirname(wtPath), { recursive: true });
  // -B so re-spawning the same id reuses/resets the branch instead of erroring
  const args = ["worktree", "add", "-B", branch, wtPath];
  if (opts.fromCommit) args.push(opts.fromCommit);
  await git(args, baseRepo);
  return { path: wtPath, branch, baseRepo };
}

export async function removeWorktree(info: WorktreeInfo): Promise<void> {
  try {
    await git(["worktree", "remove", "--force", info.path], info.baseRepo);
  } catch {
    // fall back to filesystem removal if git worktree remove fails
    await rm(info.path, { recursive: true, force: true });
    try {
      await git(["worktree", "prune"], info.baseRepo);
    } catch {
      /* ignore */
    }
  }
}
