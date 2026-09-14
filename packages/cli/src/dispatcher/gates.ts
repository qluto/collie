import {
  applyPresence, blockedUntil, getUsage, inputIdleSeconds, limitsAllow, listTasks, modeAdmits,
  quotaAllows, readLimits, resolveMode,
} from "@collie/core";
import type { ScheduleMode, Task } from "@collie/core";
import type { DispatcherCtx } from "./ctx.ts";

export interface TickPlan {
  mode: ScheduleMode;
  task?: Task;
  decision: string;
}

/**
 * Is some agent working in a pane collie does not own? Screen-scraped status is
 * noisy, but for "someone else is using this machine" a false positive only
 * costs one conservative tick.
 */
function otherAgentsWorking(ctx: DispatcherCtx): boolean {
  const ours = new Set(
    listTasks({ status: ["running", "blocked"] })
      .map((t) => t.run?.paneId)
      .filter((p): p is string => p !== undefined),
  );
  return ctx.agents.some((a) => a.agent_status === "working" && !ours.has(a.pane_id));
}

/**
 * Compose all dispatch gates for one tick:
 * schedule mode -> presence -> blockedUntil hard stop -> WIP -> candidate -> quota math.
 */
export function planTick(ctx: DispatcherCtx, now = new Date()): TickPlan {
  let mode = resolveMode(ctx.config.schedule, now);

  // A human's "start this now" outranks every policy gate — those exist to
  // protect a human who just said otherwise. A real limit hit still stops it:
  // the session would only scrape the same limit and be requeued.
  const forced = listTasks({ status: ["queued"] }).find((t) => t.startNow && !t.run?.paneId);
  if (forced) {
    const hardStop = blockedUntil();
    if (hardStop) {
      return { mode, decision: `start-now ${forced.id} held: limit hit; blocked until ${hardStop.toLocaleString()}` };
    }
    return { mode, task: forced, decision: `dispatching ${forced.id} (start-now requested)` };
  }

  // Presence post-processes the window's verdict; the probe is one spawnSync
  // per tick and only runs when the feature is on.
  let presence: string | undefined;
  if (ctx.config.presence.enabled) {
    const signals = { idleSec: inputIdleSeconds(), othersWorking: otherAgentsWorking(ctx) };
    const res = applyPresence(mode, signals, ctx.config.presence);
    mode = res.mode;
    presence = res.reason;
  }
  const decide = (decision: string) => (presence ? `${presence}; ${decision}` : decision);

  if (mode === "paused") {
    return { mode, decision: presence ?? "paused by schedule window" };
  }

  const hardStop = blockedUntil();
  if (hardStop) {
    return { mode, decision: decide(`limit hit earlier; blocked until ${hardStop.toLocaleString()}`) };
  }

  // WIP is work in flight only: a task blocked on a question consumes no tokens
  // and no attention until morning, so counting it would let one stuck pane
  // starve the whole night.
  const wip = listTasks({ status: ["running"] }).length;
  if (wip >= ctx.config.dispatch.wipLimit) {
    return { mode, decision: decide(`wip full (${wip}/${ctx.config.dispatch.wipLimit})`) };
  }

  // Blocked tasks are still a backstop: past this many unanswered questions the
  // night has gone sideways and more dispatches just add to the pile.
  const asking = listTasks({ status: ["blocked"] }).length;
  if (asking >= ctx.config.dispatch.askingLimit) {
    return {
      mode,
      decision: decide(`asking limit (${asking}/${ctx.config.dispatch.askingLimit}) — answer questions in the TUI`),
    };
  }

  const cap = ctx.config.quota.conservativeMaxSize;
  const queued = listTasks({ status: ["queued"] }).filter((t) => !t.run?.paneId);
  const candidate = queued.find((t) => modeAdmits(t, mode, cap));
  if (!candidate) {
    if (queued.length === 0) {
      return { mode, decision: decide(`queue empty (wip ${wip}/${ctx.config.dispatch.wipLimit})`) };
    }
    return {
      mode,
      decision: decide(`no candidate fits ${mode} mode (${queued.length} over size cap ${cap}) — waiting for a full window`),
    };
  }

  // Anthropic's own percentages when we have a fresh reading (refreshLimits runs
  // at the top of the tick); ccusage's token estimate only as a fallback.
  const limits = readLimits();
  const verdict = limits
    ? limitsAllow(ctx.config.quota, mode, limits, now.getTime())
    : quotaAllows(ctx.config.quota, mode, candidate.size, getUsage());
  if (!verdict.allow) return { mode, decision: decide(verdict.reason) };

  return { mode, task: candidate, decision: decide(`dispatching ${candidate.id} (${verdict.reason})`) };
}
