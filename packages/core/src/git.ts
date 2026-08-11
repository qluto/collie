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

/**
 * Every local branch name. gc asks "does this branch still exist?" once per
 * repo instead of once per task: a human who merged and deleted a collie branch
 * by hand leaves nothing behind, and that has to read as "already collected",
 * never as an unanswerable question.
 */
export function localBranches(repoRoot: string): string[] {
  const res = git(repoRoot, ["branch", "--format=%(refname:short)"]);
  return res.ok ? res.out.split("\n").map((b) => b.trim()).filter(Boolean) : [];
}

/**
 * The MAIN repository containing `dir`, or null when it is not in a git
 * worktree at all. Deliberately not `--show-toplevel`: standing inside one of
 * collie's own worktrees, that answers the worktree checkout, and a task
 * created against it would spawn a worktree of a worktree. `--git-common-dir`
 * points at the main repo's .git from anywhere, linked worktrees included.
 */
export function repoRootOf(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const common = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok || !common.out) return null;
  // bare repos have no working tree to create tasks against
  return common.out.endsWith("/.git") ? common.out.slice(0, -"/.git".length) : null;
}

export interface DirtyState {
  /** Modified/staged/deleted files under version control — losing these loses work. */
  tracked: string[];
  /** `??` files: build output, scratch notes, an agent's AGENTS.md. */
  untracked: string[];
}

/**
 * Split rather than counted, because the two halves carry different risk: a
 * tracked change is work git cannot get back, while untracked files are usually
 * residue. gc stops dead on the former and needs `--force` for the latter.
 */
export function dirtyState(worktreePath: string): DirtyState {
  if (!fs.existsSync(worktreePath)) return { tracked: [], untracked: [] };
  const res = git(worktreePath, ["status", "--porcelain"]);
  const lines = res.ok ? res.out.split("\n").filter(Boolean) : [];
  return {
    tracked: lines.filter((l) => !l.startsWith("??")),
    untracked: lines.filter((l) => l.startsWith("??")),
  };
}

/** Uncommitted or untracked files in a worktree; empty means safe to remove. */
export function dirtyFiles(worktreePath: string): string[] {
  const { tracked, untracked } = dirtyState(worktreePath);
  return [...tracked, ...untracked];
}

/**
 * Commit subjects on `branch` that HEAD does not have — null when the question
 * could not be asked at all (branch gone, repo moved). Answering [] there would
 * report a vanished branch as "0 commits ahead", i.e. as unmerged work.
 */
export function commitsAhead(repoRoot: string, branch: string): string[] | null {
  const res = git(repoRoot, ["log", "--oneline", `HEAD..${branch}`]);
  return res.ok ? res.out.split("\n").filter(Boolean) : null;
}

/** " 3 files changed, 120 insertions(+), 8 deletions(-)" -> "3 files +120 −8". */
function formatShortstat(out: string): string | null {
  const files = /(\d+) files? changed/.exec(out)?.[1];
  if (!files) return null;
  const ins = /(\d+) insertions?\(\+\)/.exec(out)?.[1] ?? "0";
  const del = /(\d+) deletions?\(-\)/.exec(out)?.[1] ?? "0";
  return `${files} file${files === "1" ? "" : "s"} +${ins} −${del}`;
}

/**
 * One line of "what did this task actually change", for the harvest view.
 *
 * A worktree task is measured three-dot (`HEAD...branch`): two-dot would count
 * everything HEAD gained since the branch forked, which is the human's work,
 * not the agent's. A non-worktree task committed nothing of its own to compare
 * against, so its evidence is the checkout it ran in being dirty.
 * Any git failure (branch gone, worktree pruned, repo moved) answers null —
 * the caller renders nothing rather than an error.
 */
export function diffSummary(
  repoRoot: string,
  branch: string | undefined,
  worktreePath: string | undefined,
): string | null {
  if (branch) {
    const res = git(repoRoot, ["diff", "--shortstat", `HEAD...${branch}`]);
    if (!res.ok) return null;
    const commits = (commitsAhead(repoRoot, branch) ?? []).length;
    const parts = [
      commits > 0 ? `${commits} commit${commits === 1 ? "" : "s"}` : "",
      formatShortstat(res.out) ?? "",
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : null;
  }
  const cwd = worktreePath ?? repoRoot;
  const res = git(cwd, ["diff", "--shortstat"]);
  if (!res.ok) return null;
  const dirty = dirtyFiles(cwd).length;
  const parts = [
    dirty > 0 ? `${dirty} dirty` : "",
    formatShortstat(res.out) ?? "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * git worktree remove — refuses on a dirty checkout unless forced. `force`
 * DELETES untracked files outright, so the caller owes the human that decision;
 * it is never inferred here.
 */
export function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  opts?: { force?: boolean },
): GitResult {
  return git(repoRoot, ["worktree", "remove", ...(opts?.force ? ["--force"] : []), worktreePath]);
}

/**
 * Drops admin entries for checkouts whose directory a human deleted by hand.
 * Safe by construction: prune only forgets worktrees that are already gone.
 */
export function pruneWorktrees(repoRoot: string): GitResult {
  return git(repoRoot, ["worktree", "prune"]);
}

/** `git branch -d`: safe by construction, it refuses unmerged branches. */
export function deleteMergedBranch(repoRoot: string, branch: string): GitResult {
  return git(repoRoot, ["branch", "-d", branch]);
}
