import { dirtyFiles } from "./git.ts";
import type { Task } from "./types.ts";

/** The one HerdrClient method teardown needs — narrow so tests can stand in for the socket. */
export interface HerdrRequester {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Tear a finished task down. For a worktree task `worktree.remove` does all of
 * it — deletes the checkout, closes the pane AND the workspace — and it needs
 * the workspace to still exist, so this must never close the pane first. The
 * branch survives either way, so nothing here can lose accepted work; a dirty
 * checkout is refused here and reported back untouched.
 *
 * Returns a one-line account for the human; never throws.
 */
export async function teardownTask(task: Task, herdr: HerdrRequester): Promise<string> {
  const worktreePath = task.run?.worktreePath;
  const workspaceId = task.run?.workspaceId;

  if (task.worktree && worktreePath && workspaceId) {
    const dirty = dirtyFiles(worktreePath);
    if (dirty.length > 0) {
      return `kept the worktree: ${dirty.length} uncommitted file(s) in ${worktreePath}`;
    }
    try {
      await herdr.request("worktree.remove", { workspace_id: workspaceId });
      return `worktree removed (branch ${task.branch ?? "?"} kept)`;
    } catch (err) {
      return `worktree.remove failed: ${(err as Error).message}`;
    }
  }
  if (task.run?.paneId) {
    try {
      await herdr.request("pane.close", { pane_id: task.run.paneId });
      return "pane closed";
    } catch (err) {
      return `pane.close failed: ${(err as Error).message}`;
    }
  }
  return "nothing to close";
}
