/**
 * Cross-worker handoff artifacts (Phase 2/3).
 *
 * Phase 1 injected a predecessor's *result text* inline. That breaks down for
 * code handoffs: the thing worth passing on is the actual patch, it can be far
 * larger than a prompt, and it is exactly the kind of text most likely to carry
 * a secret. So a diff handoff is produced as a **redacted sidecar file** the
 * successor is told to read, and `base: "predecessor"` starts the successor from
 * a **snapshot commit** of the predecessor's working tree.
 *
 * Everything here is best-effort by design:
 *  - redaction is pattern-based, so it reduces accidental leakage, it does NOT
 *    guarantee a secret-free artifact — the artifact is still untrusted data;
 *  - the snapshot/diff are built against a temporary index, so the predecessor's
 *    own index, HEAD and working tree are never modified.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const run = promisify(execFile);

/** A handoff could not be produced for a reason the caller should surface. */
export class HandoffError extends Error {
  constructor(
    readonly code:
      | "handoff_artifact_unavailable"
      | "handoff_artifact_too_large"
      | "handoff_base_unavailable"
      | "handoff_base_requires_worktree",
    message: string,
  ) {
    super(message);
    this.name = "HandoffError";
  }
}

type GitEnv = NodeJS.ProcessEnv;

async function git(args: string[], cwd: string, env?: GitEnv): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    env: env ?? process.env,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function tryGit(args: string[], cwd: string, env?: GitEnv): Promise<string | undefined> {
  try {
    return await git(args, cwd, env);
  } catch {
    return undefined;
  }
}

export async function isGitWorkTree(dir: string): Promise<boolean> {
  return (await tryGit(["rev-parse", "--is-inside-work-tree"], dir))?.trim() === "true";
}

/**
 * Run `fn` against a throwaway index seeded from HEAD, so staging untracked
 * files (needed for a complete diff) never disturbs the real index.
 */
async function withTempIndex<T>(dir: string, fn: (env: GitEnv) => Promise<T>): Promise<T> {
  const tmp = await mkdtemp(path.join(tmpdir(), "agentmesh-idx-"));
  const env: GitEnv = {
    ...process.env,
    GIT_INDEX_FILE: path.join(tmp, "index"),
    // Deterministic identity: commit-tree must work even where no git user is
    // configured (CI, containers, a bare checkout).
    GIT_AUTHOR_NAME: "agentmesh",
    GIT_AUTHOR_EMAIL: "agentmesh@localhost",
    GIT_COMMITTER_NAME: "agentmesh",
    GIT_COMMITTER_EMAIL: "agentmesh@localhost",
  };
  try {
    const head = await tryGit(["rev-parse", "--verify", "HEAD"], dir, env);
    if (head) await git(["read-tree", "HEAD"], dir, env);
    else await git(["read-tree", "--empty"], dir, env);
    return await fn(env);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/* ------------------------------- redaction ------------------------------- */

export interface RedactionReport {
  /** How many matches were replaced, per kind. */
  counts: Record<string, number>;
  total: number;
}

interface Rule {
  kind: string;
  re: RegExp;
  /** Build the replacement; defaults to a fixed `[REDACTED:kind]` marker. */
  replace?: (match: string, ...groups: string[]) => string;
}

const RULES: Rule[] = [
  // Multi-line blocks first: a key body often contains things later rules match.
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: "openai-key", re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "bearer", re: /\bBearer\s+[A-Za-z0-9._-]{16,}/g },
  {
    // Keep the key and separator so the patch still reads correctly.
    kind: "assignment",
    re: /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)(\s*[:=]\s*)(["']?)([^\s"',]{8,})/gi,
    replace: (_m, key, sep, quote) => `${key}${sep}${quote}[REDACTED:assignment]`,
  },
];

/**
 * Replace secret-shaped substrings with `[REDACTED:<kind>]` markers.
 *
 * Deliberately conservative in what it claims: this is a cheap safety net on
 * top of "the artifact is untrusted data", not a secret scanner. Purely local
 * values with no recognisable shape (a password that looks like a word) pass
 * through untouched.
 */
export function redactSecrets(text: string): { text: string; report: RedactionReport } {
  let out = text;
  const counts: Record<string, number> = {};
  for (const rule of RULES) {
    out = out.replace(rule.re, (...args: unknown[]) => {
      const match = String(args[0]);
      counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
      if (rule.replace) {
        const groups = args.slice(1, -2).map((g) => (g == null ? "" : String(g)));
        return rule.replace(match, ...groups);
      }
      return `[REDACTED:${rule.kind}]`;
    });
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { text: out, report: { counts, total } };
}

/* ---------------------------------- diff --------------------------------- */

export interface DiffCapture {
  /** Unified diff including untracked (non-ignored) files; empty string if none. */
  text: string;
  filesChanged: number;
  addedLines: number;
  deletedLines: number;
  untrackedFiles: number;
}

/**
 * Capture the working-tree diff of `dir` — tracked modifications *and* new
 * untracked files, honouring `.gitignore` — without touching its real index.
 */
export async function captureWorkingTreeDiff(dir: string): Promise<DiffCapture> {
  if (!(await isGitWorkTree(dir))) {
    throw new HandoffError(
      "handoff_artifact_unavailable",
      `cannot capture a diff: "${dir}" is not inside a git working tree`,
    );
  }
  return withTempIndex(dir, async (env) => {
    await git(["add", "-A"], dir, env);
    const hasHead = (await tryGit(["rev-parse", "--verify", "HEAD"], dir, env)) !== undefined;
    const diffArgs = ["diff", "--cached", "--no-color", "--no-ext-diff"];
    // Against HEAD when there is one; an unborn HEAD stages everything as new.
    if (hasHead) diffArgs.push("HEAD");
    const text = await git(diffArgs, dir, env);

    const numstat = await git(
      hasHead
        ? ["diff", "--cached", "--numstat", "HEAD"]
        : ["diff", "--cached", "--numstat"],
      dir,
      env,
    );
    let filesChanged = 0;
    let addedLines = 0;
    let deletedLines = 0;
    for (const line of numstat.split("\n")) {
      if (!line.trim()) continue;
      const [add, del] = line.split("\t");
      filesChanged++;
      // "-" means binary; count it as a changed file with no line stats.
      if (add !== "-") addedLines += Number(add) || 0;
      if (del !== "-") deletedLines += Number(del) || 0;
    }
    // "new file mode" appears once per added file in the unified diff.
    const untrackedFiles = (text.match(/^new file mode /gm) ?? []).length;

    return { text, filesChanged, addedLines, deletedLines, untrackedFiles };
  });
}

/* --------------------------------- snapshot ------------------------------- */

/**
 * Snapshot the working tree of `dir` into a commit object and return its SHA.
 *
 * Used by `base: "predecessor"`: the successor's worktree branches from this
 * commit, so it sees the predecessor's uncommitted edits and untracked files.
 * Built with plumbing (`write-tree` + `commit-tree`) against a temp index, so
 * the predecessor's branch, index and working tree stay exactly as they were.
 */
export async function snapshotWorkingTree(dir: string, message?: string): Promise<string> {
  if (!(await isGitWorkTree(dir))) {
    throw new HandoffError(
      "handoff_base_unavailable",
      `cannot snapshot "${dir}": not inside a git working tree`,
    );
  }
  return withTempIndex(dir, async (env) => {
    await git(["add", "-A"], dir, env);
    const tree = (await git(["write-tree"], dir, env)).trim();
    const head = await tryGit(["rev-parse", "--verify", "HEAD"], dir, env);
    const args = ["commit-tree", tree];
    if (head) args.push("-p", head.trim());
    args.push("-m", message ?? "agentmesh: cross-worker handoff snapshot");
    const commit = await git(args, dir, env);
    return commit.trim();
  });
}

/**
 * The common git dir of two working trees, so callers can check that a snapshot
 * commit is reachable from the repo the successor's worktree will be created in.
 */
export async function sameRepository(a: string, b: string): Promise<boolean> {
  const [ca, cb] = await Promise.all([
    tryGit(["rev-parse", "--git-common-dir"], a),
    tryGit(["rev-parse", "--git-common-dir"], b),
  ]);
  if (ca === undefined || cb === undefined) return false;
  return path.resolve(a, ca.trim()) === path.resolve(b, cb.trim());
}

/* --------------------------------- sidecar -------------------------------- */

/** Absolute path of the sidecar file a diff handoff is written to. */
export function handoffSidecarPath(workdir: string, taskId: string): string {
  return path.resolve(workdir, "handoffs", `${taskId}.diff`);
}

/**
 * Bare file name of a diff artifact, used when the patch has to travel to
 * another host. Deliberately a *name*, not a path: the receiving daemon decides
 * which directory it lands in, so a master cannot steer a write anywhere.
 */
export function handoffArtifactName(taskId: string): string {
  return `${taskId}.diff`;
}

/** Write the (already redacted, already capped) diff for a successor task. */
export async function writeHandoffSidecar(
  workdir: string,
  taskId: string,
  text: string,
): Promise<string> {
  const target = handoffSidecarPath(workdir, taskId);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
  return target;
}
