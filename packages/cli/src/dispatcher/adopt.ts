import { refreshBranchScan, transition } from "@collie/core";
import { log, type DispatcherCtx } from "./ctx.ts";

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
export function adoptMerged(ctx: DispatcherCtx): void {
  const scan = refreshBranchScan({ maxAgeSec: 0 });
  for (const id of scan.adoptable) {
    try {
      transition(id, "done", undefined, { source: "merge-detect" });
      log(ctx, `task ${id}: branch merged into HEAD, adopted as done`);
    } catch (err) {
      // A concurrent TUI action (retry, manual done) can beat us to it; the
      // next tick re-derives the truth either way.
      log(ctx, `task ${id}: adopt failed: ${(err as Error).message}`);
    }
  }
}
