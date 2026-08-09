import {
  blockedUntil, getUsage, limitsAllow, listTasks, modeAdmits, quotaAllows, readLimits, resolveMode,
} from "@collie/core";
import type { ScheduleMode, Task } from "@collie/core";
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

  // WIP is work in flight only: a task blocked on a question consumes no tokens
  // and no attention until morning, so counting it would let one stuck pane
  // starve the whole night.
  const wip = listTasks({ status: ["running"] }).length;
  if (wip >= ctx.config.dispatch.wipLimit) {
    return { mode, decision: `wip full (${wip}/${ctx.config.dispatch.wipLimit})` };
  }

  // Blocked tasks are still a backstop: past this many unanswered questions the
  // night has gone sideways and more dispatches just add to the pile.
  const asking = listTasks({ status: ["blocked"] }).length;
  if (asking >= ctx.config.dispatch.askingLimit) {
    return {
      mode,
      decision: `asking limit (${asking}/${ctx.config.dispatch.askingLimit}) — answer questions in the TUI`,
    };
  }

  const cap = ctx.config.quota.conservativeMaxSize;
  const queued = listTasks({ status: ["queued"] }).filter((t) => !t.run?.paneId);
  const candidate = queued.find((t) => modeAdmits(t, mode, cap));
  if (!candidate) {
    if (queued.length === 0) {
      return { mode, decision: `queue empty (wip ${wip}/${ctx.config.dispatch.wipLimit})` };
    }
    return {
      mode,
      decision: `no candidate fits ${mode} mode (${queued.length} over size cap ${cap}) — waiting for a full window`,
    };
  }

  // Anthropic's own percentages when we have a fresh reading (refreshLimits runs
  // at the top of the tick); ccusage's token estimate only as a fallback.
  const limits = readLimits();
  const verdict = limits
    ? limitsAllow(ctx.config.quota, mode, limits)
    : quotaAllows(ctx.config.quota, mode, candidate.size, getUsage());
  if (!verdict.allow) return { mode, decision: verdict.reason };

  return { mode, task: candidate, decision: `dispatching ${candidate.id} (${verdict.reason})` };
}
