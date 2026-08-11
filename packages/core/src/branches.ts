import * as fs from "node:fs";
import * as path from "node:path";
import { branchScanPath, hubHome } from "./paths.ts";
import { branchState, discardBranch, dirtyState, pruneWorktrees, removeWorktree } from "./git.ts";
import { getTask, listArchived, listTasks } from "./store.ts";
import type { Task } from "./types.ts";

/**
 * Where a finished task's work actually ended up. collie's `done` means "a
 * human dealt with this", which is not the same as "it landed": the answer
 * lives in git, so it is read from git rather than recorded at done-time. Read
 * that way it also self-corrects — merge a dropped task's branch a week later
 * and it stops being dropped, discard the branch and it stops being anything.
 */
export interface BranchScan {
  checkedAt: string;
  /**
   * Repos worth asking about next time. Seeded from the working set and kept
   * while any `collie/*` branch survives there, so the roster needs no archive
   * scan to stay complete — and prunes itself once gc has swept a repo.
   */
  repos: string[];
  /** review tasks whose own commits are already contained in HEAD. */
  adoptable: string[];
  /** tasks that left the working set with their branch still unmerged. */
  dropped: string[];
}

const BRANCH_PREFIX = "collie/";

/**
 * Archived tasks read once, to seed the roster when there is no previous scan
 * to inherit it from — a first run whose tasks are all finished would otherwise
 * have no repo to look in and report nothing dropped. Bounded because the
 * archive is the one directory that grows without bound; every later scan
 * carries its own roster and reads none of it.
 */
const COLD_START_SEED = 50;

export function readBranchScan(): BranchScan | null {
  try {
    return JSON.parse(fs.readFileSync(branchScanPath(), "utf8")) as BranchScan;
  } catch {
    return null;
  }
}

function writeBranchScan(scan: BranchScan): void {
  const tmp = path.join(hubHome(), `.branches.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(scan, null, 2));
  fs.renameSync(tmp, branchScanPath()); // the TUI reads this file mid-write otherwise
}

function ageSec(scan: BranchScan): number {
  const t = Date.parse(scan.checkedAt);
  return Number.isNaN(t) ? Infinity : (Date.now() - t) / 1000;
}

/**
 * Re-derive the scan unless the cached one is younger than `maxAgeSec` — the
 * dispatcher passes 0 because it acts on the result, the TUI passes a window so
 * that two processes watching the same repos cost one pair of git calls.
 */
export function refreshBranchScan(opts?: { maxAgeSec?: number }): BranchScan {
  const cached = readBranchScan();
  if (cached && ageSec(cached) < (opts?.maxAgeSec ?? 30)) return cached;

  // The working set answers "is this task still live?" for free, which is what
  // separates a dropped task's branch from one that is merely still in flight.
  const live = new Map(listTasks().map((t) => [t.id, t]));
  const seed = cached?.repos ?? listArchived(COLD_START_SEED).tasks.map((t) => t.repo);
  const roster = [...new Set([
    ...[...live.values()].filter((t) => t.worktree && t.branch).map((t) => t.repo),
    ...seed,
  ])].filter((repo) => fs.existsSync(repo));

  const scan: BranchScan = { checkedAt: new Date().toISOString(), repos: [], adoptable: [], dropped: [] };
  for (const repo of roster) {
    const { tips, merged } = branchState(repo);
    let seen = false;
    for (const [name, tip] of tips) {
      if (!name.startsWith(BRANCH_PREFIX)) continue;
      seen = true;
      const id = name.slice(BRANCH_PREFIX.length);
      const task = live.get(id);
      if (!merged.has(name)) {
        if (!task) scan.dropped.push(id);
        continue;
      }
      // Merged, but a branch that never got a commit of its own is merged
      // vacuously — auto-completing it would archive a task whose result (an
      // uncommitted plan, say) no human has read. baseCommit is what tells the
      // two apart, and tasks dispatched before it existed answer "don't know".
      if (task?.status === "review" && task.run?.baseCommit && task.run.baseCommit !== tip) {
        scan.adoptable.push(id);
      }
    }
    if (seen) scan.repos.push(repo);
  }
  writeBranchScan(scan);
  return scan;
}

/**
 * Throw away everything a dropped task left behind. The order is the whole
 * point: git refuses to delete a branch a checkout still holds, so the worktree
 * goes first and the admin entry is pruned before the branch is touched.
 *
 * Untracked files go with it — the human confirmed a discard — but tracked
 * changes stop this dead. Nothing else in collie can get those back.
 */
export function discardTaskWork(task: Task): { ok: boolean; message: string } {
  if (!task.branch) return { ok: false, message: `${task.id} has no branch` };
  const wt = task.run?.worktreePath;
  if (wt && fs.existsSync(wt)) {
    const { tracked, untracked } = dirtyState(wt);
    if (tracked.length > 0) {
      return { ok: false, message: `${tracked.length} uncommitted change(s) in ${wt}` };
    }
    const res = removeWorktree(task.repo, wt, { force: untracked.length > 0 });
    if (!res.ok) return { ok: false, message: res.err };
  }
  pruneWorktrees(task.repo);
  const res = discardBranch(task.repo, task.branch);
  return res.ok
    ? { ok: true, message: `discarded ${task.branch}` }
    : { ok: false, message: res.err };
}

/**
 * The dropped set as whole tasks, newest first. Reads only those few archived
 * files by id — the scan comes from the branch side, so nothing here walks the
 * archive, which is the one directory that grows without bound.
 */
export function droppedTasks(opts?: { maxAgeSec?: number }): Task[] {
  return refreshBranchScan(opts)
    .dropped
    .map((id) => getTask(id))
    .filter((t): t is Task => t !== null && t.status === "done")
    .sort((a, b) => (b.endedAt ?? b.updatedAt).localeCompare(a.endedAt ?? a.updatedAt));
}
