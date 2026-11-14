import { findPullRequest, listTasks, pullRequestLanded, updateTask } from "@collie/core";
import { adoptTask } from "./adopt.ts";
import { log, type DispatcherCtx } from "./ctx.ts";
import { reportStatus } from "./dispatch.ts";

/** How stale a previous gh answer may be before it is asked again. */
const RECHECK_MS = 10 * 60_000;
/** gh calls per tick. One is cheap; a night's worth of tasks at once is not. */
const MAX_PER_TICK = 3;

/**
 * Find the pull request a session opened for its branch, so the sidebar row and
 * the TUI can show "#1234" next to the task.
 *
 * The session is what opens the PR, and it does so at a moment collie never
 * hears about — hence polling rather than a hook. Cheap on purpose: only tasks
 * that could have one (a branch, no PR found yet) and at most a few per tick,
 * each behind gh's own 15s ceiling.
 *
 * A review task keeps being asked after its PR is known, because the PR's
 * state is the one merge signal git cannot give: a squash or rebase merge never
 * makes the branch contained in main, and a merge on GitHub is invisible to the
 * git scan until something fetches. A PR merged into the default branch adopts
 * the task as done, exactly like a merge the scan saw. Running/blocked tasks
 * are left alone even then — closing a task out from under a live agent would
 * strand its pane — and are picked up once they reach review.
 */
export async function checkPullRequests(ctx: DispatcherCtx): Promise<void> {
  const now = Date.now();
  let checked = 0;
  for (const task of listTasks({ status: ["running", "blocked", "review"] })) {
    if (checked >= MAX_PER_TICK) return;
    if (!task.branch) continue;
    if (task.run?.prUrl && task.status !== "review") continue;
    const last = Date.parse(task.run?.prCheckedAt ?? "") || 0;
    if (last > 0 && now - last < RECHECK_MS) continue;

    checked += 1;
    const pr = findPullRequest(task.repo, task.branch);
    if (task.status === "review" && pr && pullRequestLanded(task.repo, pr)) {
      await adoptTask(ctx, task.id, `pull request #${pr.number} merged into ${pr.baseRefName}`, {
        prNumber: pr.number,
        prUrl: pr.url,
        prState: "MERGED",
        prCheckedAt: new Date().toISOString(),
      });
      continue;
    }
    const known = task.run?.prUrl === pr?.url;
    updateTask(task.id, (t) => {
      t.run = {
        ...t.run,
        prCheckedAt: new Date().toISOString(),
        ...(pr ? { prNumber: pr.number, prUrl: pr.url, ...(pr.state ? { prState: pr.state } : {}) } : {}),
      };
    });
    if (!pr || known) continue;
    log(ctx, `task ${task.id} pull request #${pr.number}`);
    // The sidebar's $pr token only changes when we report again, and reportStatus
    // reads the number back off the task we just wrote.
    const paneId = task.run?.paneId;
    if (paneId && !ctx.degraded) {
      await reportStatus(ctx, task.id, paneId, task.status === "review" ? "✅ review" : "▶ running");
    }
  }
}
