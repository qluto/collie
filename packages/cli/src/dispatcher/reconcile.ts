import { listTasks, transition } from "@agent-hub/core";
import type { HerdrAgentInfo } from "@agent-hub/core";
import { log, trackPane, type DispatcherCtx } from "./ctx.ts";
import { requeueOrFail } from "./dispatch.ts";

/**
 * Reality check against Herdr, every tick:
 * - refresh the agent.list snapshot (degraded mode when the socket is down)
 * - running/blocked task whose pane is gone -> requeue or fail
 * - running/blocked task with a live pane -> ensure we hold a subscription
 *   (covers dispatcher restarts)
 * - queued task whose session-start hook already recorded a pane (dispatcher
 *   died mid-dispatch) -> adopt it as running instead of double-spawning
 */
export async function reconcile(ctx: DispatcherCtx): Promise<void> {
  let agents: HerdrAgentInfo[];
  try {
    const res = await ctx.herdr.request<{ agents: HerdrAgentInfo[] }>("agent.list");
    agents = res.agents ?? [];
    if (ctx.degraded) log(ctx, "herdr socket is back; leaving degraded mode");
    ctx.degraded = false;
  } catch (err) {
    if (!ctx.degraded) log(ctx, `herdr unreachable (${(err as Error).message}); entering degraded mode`);
    ctx.degraded = true;
    return; // keep all state as-is; never punish tasks for a dead socket
  }
  ctx.agents = agents;
  const livePanes = new Set(agents.map((a) => a.pane_id));

  for (const task of listTasks({ status: ["running", "blocked"] })) {
    const paneId = task.run?.paneId;
    if (!paneId || !livePanes.has(paneId)) {
      const tracker = ctx.panes.get(task.id);
      // A pane that briefly drops out of agent detection is not dead; only
      // treat it as gone when the pane truly vanished or exit was observed.
      if (paneId && !tracker?.exited && agentPaneMayExist(agents, paneId)) continue;
      requeueOrFail(ctx, task.id, "pane_exited");
      continue;
    }
    trackPane(ctx, task.id, paneId); // no-op when already tracked
  }

  for (const task of listTasks({ status: ["queued"] })) {
    const paneId = task.run?.paneId;
    if (paneId && livePanes.has(paneId)) {
      log(ctx, `adopting half-spawned pane ${paneId} for ${task.id}`);
      trackPane(ctx, task.id, paneId);
      transition(task.id, "running", undefined, { source: "dispatcher-reconcile" });
    }
  }
}

/**
 * agent.list only reports panes with a detected agent. A pane whose claude is
 * merely undetected (e.g. transient screen state) should not be declared dead.
 * Without a pane.list probe we err on the safe side for a few ticks: the
 * watchdog's idle-timeout eventually routes truly wedged tasks to review.
 */
function agentPaneMayExist(_agents: HerdrAgentInfo[], _paneId: string): boolean {
  return false; // Phase 1: trust agent.list; revisit with pane.list in Phase 4
}
