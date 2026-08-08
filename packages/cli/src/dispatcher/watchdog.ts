import { listTasks, transition } from "@agent-hub/core";
import { log, untrackPane, type DispatcherCtx } from "./ctx.ts";
import { requeueOrFail } from "./dispatch.ts";

/**
 * Route wedged work to a human, every tick:
 * - pane.exited observed by a subscription -> requeue or fail
 * - running task idle past the grace period without a completion callback
 *   -> review + notification (the completion CLI callback is the primary
 *   signal; this is the fallback so nothing hangs silently)
 */
export async function watchdog(ctx: DispatcherCtx): Promise<void> {
  if (ctx.degraded) return;
  const graceMs = ctx.config.dispatch.idleGraceMin * 60_000;
  const now = Date.now();

  for (const task of listTasks({ status: ["running"] })) {
    const tracker = task.run?.paneId ? ctx.panes.get(task.id) : undefined;

    if (tracker?.exited) {
      requeueOrFail(ctx, task.id, "pane_exited");
      continue;
    }

    const herdrIdle =
      tracker?.lastStatus === "idle" ||
      tracker?.lastStatus === "done" ||
      ctx.agents.find((a) => a.pane_id === task.run?.paneId)?.agent_status === "idle";
    if (!herdrIdle) continue;

    const lastActivity = Math.max(
      Date.parse(task.run?.lastHeartbeatAt ?? "") || 0,
      Date.parse(task.startedAt ?? "") || 0,
    );
    if (lastActivity === 0 || now - lastActivity < graceMs) continue;

    transition(task.id, "review", undefined, { source: "watchdog" });
    untrackPane(ctx, task.id);
    log(ctx, `task ${task.id} idle ${Math.round((now - lastActivity) / 60000)}min without completion -> review`);
    try {
      await ctx.herdr.request("notification.show", {
        title: "agent-hub",
        body: `${task.id} needs review (went idle without completing)`,
        sound: "request",
      });
    } catch {
      // notification is best-effort
    }
  }
}
