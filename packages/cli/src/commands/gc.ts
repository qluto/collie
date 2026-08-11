import * as fs from "node:fs";
import { parseArgs } from "node:util";
import {
  archivedTaskFilePath, commitsAhead, deleteMergedBranch, dirtyState, ensureDataDirs, listTasks,
  localBranches, mergedBranches, pruneWorktrees, removeWorktree, taskFilePath, withLock,
  type Task,
} from "@collie/core";

interface Verdict {
  task: Task;
  action: string;
  done: boolean;
}

interface Sweep {
  verdicts: Verdict[];
  /** Finished tasks with nothing left to collect — counted, never listed. */
  clean: number;
}

interface RepoView {
  branches: Set<string>;
  merged: Set<string>;
}

/**
 * A finished task leaves two things behind: the worktree checkout and the
 * `collie/<id>` branch. The checkout is disposable once it is clean (the
 * commits live in the repo, not the checkout), but the branch is the work
 * itself — so only branches already contained in the repo's HEAD are deleted.
 * `git branch -d` refuses anything else, which is the real safety net here.
 *
 * A task earns a verdict ONLY while something collectable survives. The archive
 * grows forever, so a task whose branch a human already merged and deleted by
 * hand must drop out of the report entirely rather than reappear every run —
 * gc's output has to stay short enough to be read.
 */
function collect(dryRun: boolean, force: boolean): Sweep {
  const finished = listTasks({ status: ["done", "failed"], includeArchived: true })
    .filter((t) => t.worktree && t.branch);
  const views = new Map<string, RepoView>();
  const view = (repo: string): RepoView => {
    if (!views.has(repo)) {
      // Prune FIRST: a checkout a human deleted with rm leaves an admin entry,
      // and git refuses to delete a branch "used by" it — the branch would be
      // stuck for good. Prune only forgets worktrees already gone from disk.
      if (!dryRun) pruneWorktrees(repo);
      views.set(repo, { branches: new Set(localBranches(repo)), merged: new Set(mergedBranches(repo)) });
    }
    return views.get(repo)!;
  };

  const sweep: Sweep = { verdicts: [], clean: 0 };
  for (const task of finished) {
    const branch = task.branch!;
    const wt = task.run?.worktreePath;
    const checkoutLeft = !!wt && fs.existsSync(wt);
    // A repo that is gone took its branches and checkouts with it; there is
    // nothing left for gc to act on, now or on any future run.
    if (!fs.existsSync(task.repo)) {
      sweep.clean++;
      continue;
    }
    const { branches, merged } = view(task.repo);
    const branchLeft = branches.has(branch);
    if (!branchLeft && !checkoutLeft) {
      sweep.clean++;
      continue;
    }

    // The branch cannot be deleted while a checkout still holds it. Removing the
    // checkout is safe on its own — the commits live in the repo, not here.
    let checkout = "";
    if (checkoutLeft) {
      const { tracked, untracked } = dirtyState(wt!);
      if (tracked.length > 0) {
        // Not forceable: --force would delete work git cannot get back.
        sweep.verdicts.push({
          task,
          action: `kept worktree: ${tracked.length} uncommitted change(s) in ${wt}`,
          done: false,
        });
        continue;
      }
      if (untracked.length > 0 && !force) {
        sweep.verdicts.push({
          task,
          action: `kept worktree: ${untracked.length} untracked file(s) in ${wt} (--force to delete)`,
          done: false,
        });
        continue;
      }
      const forced = untracked.length > 0;
      if (dryRun) {
        checkout = forced ? `would remove worktree (+${untracked.length} untracked); ` : "would remove worktree; ";
      } else {
        const res = removeWorktree(task.repo, wt!, { force: forced });
        if (!res.ok) {
          sweep.verdicts.push({ task, action: `worktree remove failed: ${res.err}`, done: false });
          continue;
        }
        checkout = forced ? `worktree removed (+${untracked.length} untracked); ` : "worktree removed; ";
      }
    }

    if (!branchLeft) {
      // Nothing else to do: the checkout above was the whole residue.
      sweep.verdicts.push({ task, action: `${checkout}branch ${branch} was already gone`, done: true });
      continue;
    }
    if (!merged.has(branch)) {
      const ahead = commitsAhead(task.repo, branch);
      const why = ahead === null ? "not merged" : `not merged (${ahead.length} commit(s) ahead of HEAD)`;
      sweep.verdicts.push({ task, action: `${checkout}kept ${branch}: ${why}`, done: false });
      continue;
    }
    if (dryRun) {
      sweep.verdicts.push({ task, action: `${checkout}would delete merged branch ${branch}`, done: true });
      continue;
    }
    const res = deleteMergedBranch(task.repo, branch);
    sweep.verdicts.push(res.ok
      ? { task, action: `${checkout}deleted merged branch ${branch}`, done: true }
      : { task, action: `${checkout}branch delete failed: ${res.err}`, done: false });
  }

  return sweep;
}

/**
 * Done tasks are archived by `transition` now, but files finished before that
 * change are still sitting in the working set. Sweep them on the way past.
 */
function sweepDoneIntoArchive(dryRun: boolean): string[] {
  ensureDataDirs();
  return withLock(() =>
    listTasks({ status: ["done"] }).flatMap((t) => {
      if (!fs.existsSync(taskFilePath(t.id))) return []; // already archived
      if (dryRun) return [`would archive ${t.id}`];
      fs.renameSync(taskFilePath(t.id), archivedTaskFilePath(t.id));
      return [`archived ${t.id}`];
    }),
  );
}

/** `collie gc [--dry-run] [--force]` — drop worktrees and merged branches of finished tasks. */
export function runGcCommand(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
  });
  const dryRun = values["dry-run"]!;
  for (const line of sweepDoneIntoArchive(dryRun)) console.log(`✓ ${line}`);

  const { verdicts, clean } = collect(dryRun, values.force!);
  for (const v of verdicts) {
    console.log(`${v.done ? "✓" : "·"} ${v.task.id}  ${v.action}`);
  }
  const already = clean > 0 ? ` · ${clean} already clean` : "";
  const suffix = `${already}${dryRun ? " (dry run)" : ""}`;
  if (verdicts.length === 0) {
    console.log(`nothing to collect${clean > 0 ? ` (${clean} finished task(s) already clean)` : ""}`);
    return 0;
  }
  console.log(`${verdicts.filter((v) => v.done).length}/${verdicts.length} cleaned${suffix}`);
  return 0;
}
