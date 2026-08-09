import type { Config, HerdrAgentInfo, HerdrAgentStatus } from "@collie/core";
import { HerdrClient, type SubscriptionHandle } from "@collie/core";

/** Live info the dispatcher tracks per running task pane. */
export interface PaneTracker {
  taskId: string;
  paneId: string;
  sub?: SubscriptionHandle;
  lastStatus?: HerdrAgentStatus;
  lastStatusAt?: number;
  exited?: boolean;
}

export interface DispatcherCtx {
  config: Config;
  herdr: HerdrClient;
  startedAt: string;
  /** taskId -> tracker for panes we own */
  panes: Map<string, PaneTracker>;
  /** last agent.list snapshot, refreshed by reconcile each tick */
  agents: HerdrAgentInfo[];
  verbose: boolean;
  lastDecision: string;
  /** last limits-refresh skip reason, so the log isn't repeated every tick */
  lastLimitsSkip?: string;
  degraded: boolean;
}

export function createCtx(config: Config, verbose: boolean): DispatcherCtx {
  return {
    config,
    herdr: new HerdrClient(config.herdr.socketPath),
    startedAt: new Date().toISOString(),
    panes: new Map(),
    agents: [],
    verbose,
    lastDecision: "starting",
    degraded: false,
  };
}

export function log(ctx: DispatcherCtx, msg: string): void {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
}

export function vlog(ctx: DispatcherCtx, msg: string): void {
  if (ctx.verbose) log(ctx, msg);
}

/** Attach (or re-attach) the event subscription for a task's pane. */
export function trackPane(ctx: DispatcherCtx, taskId: string, paneId: string): PaneTracker {
  const existing = ctx.panes.get(taskId);
  if (existing && existing.paneId === paneId && existing.sub) return existing;
  existing?.sub?.close();

  const tracker: PaneTracker = { taskId, paneId, lastStatusAt: Date.now() };
  const attach = () => {
    if (ctx.panes.get(taskId) !== tracker) return; // superseded/untracked
    tracker.sub = ctx.herdr.subscribe(
      [
        { type: "pane.agent_status_changed", pane_id: paneId },
        { type: "pane.agent_detected", pane_id: paneId },
        { type: "pane.exited", pane_id: paneId },
      ],
      (e) => {
        if (e.event === "pane.exited") {
          tracker.exited = true;
          return;
        }
        if (e.data.agent_status) {
          tracker.lastStatus = e.data.agent_status;
          tracker.lastStatusAt = Date.now();
        }
      },
      () => {
        tracker.sub = undefined;
        // Owner-driven resubscribe with a flat 2s backoff; reconcile untracks
        // panes that are truly gone, which stops the loop.
        setTimeout(attach, 2000);
      },
    );
  };
  attach();
  ctx.panes.set(taskId, tracker);
  return tracker;
}

export function untrackPane(ctx: DispatcherCtx, taskId: string): void {
  ctx.panes.get(taskId)?.sub?.close();
  ctx.panes.delete(taskId);
}
