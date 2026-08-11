import { getTask, refreshBranchScan, transition } from "@collie/core";
import { log, untrackPane, type DispatcherCtx } from "./ctx.ts";

/**
 * Merging a task's branch IS the review: the human read the diff and took it,
 * so making them also press `d` in the TUI is asking for the same decision
 * twice. The scan is the authority on what counts as landed (own commits,
 * contained in HEAD) — see core/branches.ts.
 *
 * Only review tasks are adopted. A running session may well have its branch
 * merged mid-flight, and closing the task out from under a live agent would
 * strand its pane.
 */
export async function adoptMerged(ctx: DispatcherCtx): Promise<void> {
  const scan = refreshBranchScan({ maxAgeSec: 0 });
  for (const id of scan.adoptable) {
    // Reclaim the pane BEFORE the task is archived: a finished agent sitting in
    // an idle pane holds a herdr tab and its own name, which is the id a retry
    // of this task would need. Closing the last pane of a workspace closes the
    // workspace with it, and leaves one a human has moved into alone — so this
    // needs no notion of who owns it.
    const paneId = getTask(id)?.run?.paneId;
    let closed = false;
    if (paneId) {
      try {
        await ctx.herdr.request("pane.close", { pane_id: paneId });
        closed = true;
      } catch (err) {
        // Already gone (the human closed it) reads the same as a socket that is
        // down: either way the merge still makes this task done.
        log(ctx, `task ${id}: pane.close ${paneId}: ${(err as Error).message}`);
      }
    }
    try {
      // Clearing paneId in the same patch is the only chance to do it: a done
      // task lives in the archive, which updateTask cannot reach.
      transition(id, "done", closed ? { paneId: undefined } : undefined, { source: "merge-detect" });
      if (closed) untrackPane(ctx, id);
      log(ctx, `task ${id}: branch merged into HEAD, adopted as done${closed ? ` (pane ${paneId} closed)` : ""}`);
    } catch (err) {
      // A concurrent TUI action (retry, manual done) can beat us to it; the
      // next tick re-derives the truth either way.
      log(ctx, `task ${id}: adopt failed: ${(err as Error).message}`);
    }
  }
}
