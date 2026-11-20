import { dirtyFiles } from "./git.ts";
import { realpathOr, unrecordedCheckout } from "./worktree.ts";
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
export async function teardownTask(
  task: Task,
  herdr: HerdrRequester,
  /** `defaults.worktree_root`; without it a lost run record is not looked past. */
  worktreeRoot?: string,
): Promise<string> {
  // The run record can be lost while the checkout and its workspace live on;
  // git and herdr each still know their half, so ask them before giving up.
  const worktreePath = task.run?.worktreePath
    ?? (worktreeRoot ? unrecordedCheckout(task, worktreeRoot) : undefined);
  const workspaceId = task.run?.workspaceId
    ?? (task.worktree && worktreePath ? await workspaceHolding(worktreePath, herdr) : undefined);

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

/**
 * The one herdr workspace made for a checkout, if it can be told apart. herdr
 * tags every workspace sitting in a checkout with its path — one a human
 * opened there, one a reopened session made — so a path match alone is not
 * "the task's workspace", and worktree.remove on the wrong one closes somebody
 * else's panes. Anything short of a single linked-worktree match is no answer.
 */
async function workspaceHolding(checkout: string, herdr: HerdrRequester): Promise<string | undefined> {
  try {
    const res = await herdr.request("workspace.list") as {
      workspaces?: {
        workspace_id: string;
        worktree?: { checkout_path?: string; is_linked_worktree?: boolean };
      }[];
    };
    // git answers with the resolved path; herdr with the one it was opened by.
    const wanted = realpathOr(checkout);
    const held = (res.workspaces ?? []).filter((w) =>
      w.worktree?.is_linked_worktree === true
      && !!w.worktree.checkout_path
      && realpathOr(w.worktree.checkout_path) === wanted);
    return held.length === 1 ? held[0]!.workspace_id : undefined;
  } catch {
    return undefined;
  }
}
