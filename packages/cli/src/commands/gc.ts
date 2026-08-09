import * as fs from "node:fs";
import { parseArgs } from "node:util";
import {
  archivedTaskFilePath, commitsAhead, deleteMergedBranch, dirtyFiles, ensureDataDirs, listTasks,
  mergedBranches, removeWorktree, taskFilePath, withLock,
  type Task,
} from "@collie/core";

interface Verdict {
  task: Task;
  action: string;
  done: boolean;
}

/**
 * A finished task leaves two things behind: the worktree checkout and the
 * `collie/<id>` branch. The checkout is disposable once it is clean (the
 * commits live in the repo, not the checkout), but the branch is the work
 * itself — so only branches already contained in the repo's HEAD are deleted.
 * `git branch -d` refuses anything else, which is the real safety net here.
 */
function collect(dryRun: boolean): Verdict[] {
  const finished = listTasks({ status: ["done", "failed"], includeArchived: true })
    .filter((t) => t.worktree && t.branch);
  const mergedByRepo = new Map<string, Set<string>>();
  const merged = (repo: string) => {
    if (!mergedByRepo.has(repo)) mergedByRepo.set(repo, new Set(mergedBranches(repo)));
    return mergedByRepo.get(repo)!;
  };

  return finished.map((task) => {
    const branch = task.branch!;
    if (!fs.existsSync(task.repo)) return { task, action: `repo is gone (${task.repo})`, done: false };

    // The branch cannot be deleted while a checkout still holds it. Removing the
    // checkout is safe on its own — the commits live in the repo, not here.
    let checkout = "";
    const wt = task.run?.worktreePath;
    if (wt && fs.existsSync(wt)) {
      const dirty = dirtyFiles(wt);
      if (dirty.length > 0) {
        return { task, action: `worktree has ${dirty.length} uncommitted file(s): ${wt}`, done: false };
      }
      if (dryRun) {
        checkout = "would remove worktree; ";
      } else {
        const res = removeWorktree(task.repo, wt);
        if (!res.ok) return { task, action: `worktree remove failed: ${res.err}`, done: false };
        checkout = "worktree removed; ";
      }
    }

    if (!merged(task.repo).has(branch)) {
      const ahead = commitsAhead(task.repo, branch).length;
      return {
        task,
        action: `${checkout}kept ${branch}: not merged (${ahead} commit(s) ahead of HEAD)`,
        done: false,
      };
    }
    if (dryRun) return { task, action: `${checkout}would delete merged branch ${branch}`, done: true };
    const res = deleteMergedBranch(task.repo, branch);
    return res.ok
      ? { task, action: `${checkout}deleted merged branch ${branch}`, done: true }
      : { task, action: `${checkout}branch delete failed: ${res.err}`, done: false };
  });
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

/** `collie gc [--dry-run]` — drop worktrees and merged branches of finished tasks. */
export function runGcCommand(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { "dry-run": { type: "boolean", default: false } },
  });
  for (const line of sweepDoneIntoArchive(values["dry-run"]!)) console.log(`✓ ${line}`);
  const verdicts = collect(values["dry-run"]!);
  if (verdicts.length === 0) {
    console.log("nothing to collect (no finished worktree tasks)");
    return 0;
  }
  for (const v of verdicts) {
    console.log(`${v.done ? "✓" : "·"} ${v.task.id}  ${v.action}`);
  }
  const cleaned = verdicts.filter((v) => v.done).length;
  console.log(`${cleaned}/${verdicts.length} cleaned${values["dry-run"] ? " (dry run)" : ""}`);
  return 0;
}
