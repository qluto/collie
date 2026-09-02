import * as fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

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

export interface BranchState {
  /** branch name -> tip commit; its keys are "does this branch still exist". */
  tips: Map<string, string>;
  /** branches HEAD already contains (see mergedBranches). */
  merged: Set<string>;
}

/**
 * Everything anyone asks about a repo's branches, in two calls. Per repo, not
 * per task: a human who merged and deleted a collie branch by hand leaves
 * nothing behind, and that has to read as "already collected" rather than as an
 * unanswerable question — which means existence is checked before merge is.
 */
export function branchState(repoRoot: string): BranchState {
  const res = git(repoRoot, ["branch", "--format=%(refname:short)%09%(objectname)"]);
  const tips = new Map<string, string>();
  if (res.ok) {
    for (const line of res.out.split("\n")) {
      const [name, sha] = line.split("\t");
      if (name && sha) tips.set(name.trim(), sha.trim());
    }
  }
  return { tips, merged: new Set(mergedBranches(repoRoot)) };
}

/** Commit a checkout currently sits on; the base a task's branch grew from. */
export function headCommit(dir: string): string | null {
  const res = git(dir, ["rev-parse", "HEAD"]);
  return res.ok && res.out.length > 0 ? res.out : null;
}

/**
 * The commit a branch was born on, read out of git's own record of it: the
 * oldest reflog entry is the "branch: Created from …" one, and its sha is
 * exactly what run.baseCommit would have stored. The fallback for tasks
 * dispatched before that field existed — and unlike merge-base it still answers
 * after the branch has been merged, which is when the question gets asked.
 *
 * null when the reflog is gone (expired, cloned, `core.logAllRefUpdates` off),
 * which has to read as "don't know" rather than "no commits of its own".
 */
export function forkPoint(repoRoot: string, branch: string): string | null {
  const res = git(repoRoot, ["reflog", "show", branch, "--format=%H"]);
  if (!res.ok) return null;
  const entries = res.out.split("\n").filter(Boolean);
  return entries.at(-1) ?? null;
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
 * One line of "what did this task actually change", for the task list.
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

/**
 * `git branch -D` — throws away commits nobody else has. Deliberately a
 * separate function from deleteMergedBranch, whose whole value is that git
 * refuses: this one is only ever reached through a human confirming that the
 * work is being dropped.
 */
export function discardBranch(repoRoot: string, branch: string): GitResult {
  return git(repoRoot, ["branch", "-D", branch]);
}

/**
 * git that may touch the network. spawnSync's 15s ceiling is a fine guard for
 * local plumbing and far too tight for a fetch over a slow link, so this one is
 * async with its own timeout — and never throws: an offline machine must still
 * dispatch, just from what it already has.
 */
async function gitAsync(repoRoot: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", repoRoot, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { err += c.toString(); });
    const timer = setTimeout(() => {
      err += `\ntimed out after ${Math.round(timeoutMs / 1000)}s`;
      child.kill("SIGKILL");
    }, timeoutMs);
    const done = (ok: boolean): void => {
      clearTimeout(timer);
      resolve({ ok, out: out.trim(), err: err.trim() });
    };
    child.on("error", (e) => { err += e.message; done(false); });
    child.on("close", (code) => done(code === 0));
  });
}

/**
 * The remote's primary branch, as `origin/HEAD` records it — "main" for most
 * repos, "develop" or anything else for the rest. null when the symref is
 * unset, which is common in clones that never ran `git remote set-head`; the
 * caller must treat that as "don't know", never as main.
 */
export function defaultBranch(repoRoot: string): string | null {
  const res = git(repoRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (!res.ok || !res.out) return null;
  const name = res.out.startsWith("origin/") ? res.out.slice("origin/".length) : res.out;
  return name.length > 0 ? name : null;
}

export interface WorktreeBase {
  /**
   * What to hand `worktree.create` as `base`: the COMMIT, never the ref name.
   * `git worktree add -b x path origin/main` makes the new branch TRACK
   * origin/main (branch.autoSetupMerge), and with push.default=upstream an
   * agent's plain `git push` would then land on main (live-probed 2026-09-02).
   * A sha starts no tracking; the note keeps the name for the log.
   */
  ref: string;
  /** one line for the dispatcher log: which ref, and how fresh it is */
  note: string;
}

/**
 * Which ref a task's branch should fork from, freshened first.
 *
 * The point of the fetch is that the local copy of the integration branch is
 * usually whatever the human last pulled, which at 2am may be a week old — the
 * night's work would then start from stale code and merge badly. A fetch that
 * fails (offline, no remote, bad URL) is not fatal: falling back to the last
 * fetched `origin/<name>`, or to the local branch, still beats refusing to
 * dispatch, and the note says which one happened.
 *
 * null = nothing to name, and the caller must then create the worktree with no
 * base at all (git's own HEAD default), exactly as before this existed.
 */
export async function resolveWorktreeBase(
  repoRoot: string,
  opts: { base: string; fetch: boolean },
): Promise<WorktreeBase | null> {
  const name = opts.base || defaultBranch(repoRoot);
  if (!name) return null;

  let fetched = false;
  let fetchErr = "";
  if (opts.fetch) {
    const res = await gitAsync(repoRoot, ["fetch", "--quiet", "origin", name]);
    fetched = res.ok;
    if (!res.ok) fetchErr = res.err.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "unknown error";
  }

  const remote = git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`]);
  if (remote.ok && remote.out) {
    const how = !opts.fetch
      ? "not fetched"
      : fetched
        ? "fetched"
        : `fetch failed: ${fetchErr}, using last fetched`;
    return { ref: remote.out, note: `origin/${name}@${remote.out.slice(0, 8)} (${how})` };
  }
  const local = git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
  if (local.ok && local.out) return { ref: local.out, note: `${name}@${local.out.slice(0, 8)} (local, no origin)` };
  return null;
}
