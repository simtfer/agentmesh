/**
 * Path identity for handoff refusals.
 *
 * `sameRepository` decides whether a `base: "predecessor"` successor may branch
 * from the predecessor's snapshot commit. Getting it wrong is not a cosmetic
 * bug: a *false negative* refuses a handoff that is perfectly valid, and the
 * error message then blames the user's checkout ("is gone or not in the same
 * repository") for something that is there.
 *
 * That is what the first Windows CI run found: two spellings of one directory
 * compared unequal. These cases pin the property, using aliases this machine can
 * actually create (a linked worktree and a junction/symlink), rather than
 * depending on a runner that happens to have an 8.3 short name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sameRepository } from "../src/handoff.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, windowsHide: true, stdio: "pipe" }).toString();
}

/** A repo with one commit — `git worktree add` needs a HEAD to detach from. */
function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agentmesh-paths-"));
  git(dir, "init", "--quiet");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "init");
  return dir;
}

function aliasDir(target: string, link: string): void {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

test("a linked worktree is the same repository as its main checkout", async () => {
  const repo = makeRepo();
  const wt = path.join(mkdtempSync(path.join(tmpdir(), "agentmesh-wt-")), "w");
  try {
    git(repo, "worktree", "add", "--detach", wt);
    assert.equal(await sameRepository(wt, repo), true);
    assert.equal(await sameRepository(repo, wt), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(path.dirname(wt), { recursive: true, force: true });
  }
});

test("two spellings of one directory are the same repository", async () => {
  const repo = makeRepo();
  const link = path.join(mkdtempSync(path.join(tmpdir(), "agentmesh-link-")), "alias");
  try {
    aliasDir(repo, link);
    // The aliased path is the one git answers with spelled differently once it
    // resolves symlinks / 8.3 names.
    assert.equal(await sameRepository(link, repo), true);
  } finally {
    try {
      unlinkSync(link);
    } catch {
      /* already gone */
    }
    rmSync(path.dirname(link), { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("distinct repositories and deleted checkouts are not the same repository", async () => {
  const a = makeRepo();
  const b = makeRepo();
  try {
    assert.equal(await sameRepository(a, b), false);

    const gone = path.join(a, "sub");
    rmSync(gone, { recursive: true, force: true });
    assert.equal(await sameRepository(gone, a), false);

    // Not a repository at all: git has no answer, so the honest result is false.
    const plain = mkdtempSync(path.join(tmpdir(), "agentmesh-plain-"));
    try {
      assert.equal(await sameRepository(plain, a), false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
