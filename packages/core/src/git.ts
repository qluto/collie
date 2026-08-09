import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

function git(repoRoot: string, args: string[]): GitResult {
  const res = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", timeout: 15_000 });
  return {
    ok: res.status === 0,
    out: (res.stdout ?? "").trim(),
    err: (res.stderr ?? "").trim(),
  };
}

/**
 * Branches already contained in the repo's checked-out HEAD. That is the branch
 * a human would call "merged": collie never learns a project's integration
 * branch, and `origin/HEAD` is absent in plenty of repos.
 */
export function mergedBranches(repoRoot: string): string[] {
  // --format must precede --merged: --merged takes an optional commit argument
  // and otherwise swallows the next token ("malformed object name --format=…").
  const res = git(repoRoot, ["branch", "--format=%(refname:short)", "--merged", "HEAD"]);
  return res.ok ? res.out.split("\n").map((b) => b.trim()).filter(Boolean) : [];
}

/** Uncommitted or untracked files in a worktree; empty means safe to remove. */
export function dirtyFiles(worktreePath: string): string[] {
  if (!fs.existsSync(worktreePath)) return [];
  const res = git(worktreePath, ["status", "--porcelain"]);
  return res.ok ? res.out.split("\n").filter(Boolean) : [];
}

/** Commit subjects on `branch` that HEAD does not have. */
export function commitsAhead(repoRoot: string, branch: string): string[] {
  const res = git(repoRoot, ["log", "--oneline", `HEAD..${branch}`]);
  return res.ok ? res.out.split("\n").filter(Boolean) : [];
}

/** git worktree remove — refuses on a dirty checkout unless forced. */
export function removeWorktree(repoRoot: string, worktreePath: string): GitResult {
  return git(repoRoot, ["worktree", "remove", worktreePath]);
}

/** `git branch -d`: safe by construction, it refuses unmerged branches. */
export function deleteMergedBranch(repoRoot: string, branch: string): GitResult {
  return git(repoRoot, ["branch", "-d", branch]);
}
