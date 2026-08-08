import {
  blockedUntil, getUsage, listTasks, quotaAllows, resolveMode, sizeFits,
} from "@agent-hub/core";
import type { ScheduleMode, Task } from "@agent-hub/core";
import type { DispatcherCtx } from "./ctx.ts";

export interface TickPlan {
  mode: ScheduleMode;
  task?: Task;
  decision: string;
}

/**
 * Compose all dispatch gates for one tick:
 * schedule mode -> blockedUntil hard stop -> WIP -> candidate -> quota math.
 */
export function planTick(ctx: DispatcherCtx, now = new Date()): TickPlan {
  const mode = resolveMode(ctx.config.schedule, now);
  if (mode === "paused") return { mode, decision: "paused by schedule window" };

  const hardStop = blockedUntil();
  if (hardStop) {
    return { mode, decision: `limit hit earlier; blocked until ${hardStop.toLocaleString()}` };
  }

  const wip = listTasks({ status: ["running", "blocked"] }).length;
  if (wip >= ctx.config.dispatch.wipLimit) {
    return { mode, decision: `wip full (${wip}/${ctx.config.dispatch.wipLimit})` };
  }

  const queued = listTasks({ status: ["queued"] }).filter((t) => !t.run?.paneId);
  const candidate = queued.find(
    (t) => mode === "full" || sizeFits(t.size, ctx.config.quota.conservativeMaxSize),
  );
  if (!candidate) {
    const skipped = queued.length;
    return {
      mode,
      decision: skipped
        ? `no candidate fits ${mode} mode (${skipped} queued, size cap ${ctx.config.quota.conservativeMaxSize})`
        : `queue empty (wip ${wip}/${ctx.config.dispatch.wipLimit})`,
    };
  }

  const verdict = quotaAllows(ctx.config.quota, mode, candidate.size, getUsage());
  if (!verdict.allow) return { mode, decision: verdict.reason };

  return { mode, task: candidate, decision: `dispatching ${candidate.id} (${verdict.reason})` };
}
