import { detectLimitHit, getUsage, listTasks, readQuotaState, transition, writeQuotaState } from "@collie/core";
import { log, untrackPane, type DispatcherCtx } from "./ctx.ts";
import { extractText, reportStatus, requeueOrFail } from "./dispatch.ts";

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

    const startedAtMs = Date.parse(task.startedAt ?? "") || 0;
    const lastActivity = Math.max(Date.parse(task.run?.lastHeartbeatAt ?? "") || 0, startedAtMs);

    // Suspiciously fast idle (within 3min of dispatch) or an idle timeout both
    // warrant a limit scrape: Claude prints the reset time on a limit hit.
    const suspiciousEarlyIdle = startedAtMs > 0 && now - startedAtMs < 3 * 60_000;
    const idleTimedOut = lastActivity > 0 && now - lastActivity >= graceMs;
    const paneId = task.run?.paneId;
    if ((suspiciousEarlyIdle || idleTimedOut) && paneId && (await scrapeLimit(ctx, task.id, paneId))) {
      continue;
    }
    if (!idleTimedOut) continue;

    transition(task.id, "review", undefined, { source: "watchdog" });
    if (paneId) await reportStatus(ctx, task.id, paneId, `collie ⚠ needs review: ${task.title}`);
    untrackPane(ctx, task.id);
    log(ctx, `task ${task.id} idle ${Math.round((now - lastActivity) / 60000)}min without completion -> review`);
    try {
      await ctx.herdr.request("notification.show", {
        title: "collie",
        body: `${task.id} needs review (went idle without completing)`,
        sound: "request",
      });
    } catch {
      // notification is best-effort
    }
  }
}

/**
 * Read the pane tail and look for Claude's limit-reached message. On a hit:
 * hard-stop dispatching until the reset time Claude itself printed (+jitter),
 * requeue the task WITHOUT consuming an attempt, and notify.
 */
async function scrapeLimit(ctx: DispatcherCtx, taskId: string, paneId: string): Promise<boolean> {
  let text = "";
  try {
    const read = await ctx.herdr.request<Record<string, unknown>>("pane.read", {
      pane_id: paneId, source: "visible", lines: 60,
    });
    text = extractText(read);
  } catch {
    return false;
  }
  const hit = detectLimitHit(text);
  if (!hit) return false;

  const fallbackMs = 30 * 60_000; // unparseable reset phrase: cool down 30min
  const jitterMs = (2 + Math.random() * 3) * 60_000;
  const until = new Date((hit.resetAt?.getTime() ?? Date.now() + fallbackMs) + jitterMs);
  // Record the observed block total at the moment of the hit so the user can
  // calibrate quota.block_budget_tokens against reality (session limits only).
  const usage = getUsage();
  const prevCeiling = readQuotaState().learnedBlockCeiling;
  writeQuotaState({
    blockedUntil: until.toISOString(),
    lastLimitKind: hit.kind,
    ...(hit.kind === "session" && usage.ok
      ? { learnedBlockCeiling: Math.min(usage.blockUsedTokens, prevCeiling ?? Infinity) }
      : {}),
  });
  log(ctx, `LIMIT HIT (${hit.kind}) on ${taskId}: resets "${hit.resetPhrase}" -> blocked until ${until.toISOString()}`);

  transition(taskId, "queued", { paneId: undefined, tabId: undefined, sessionId: undefined }, { source: "watchdog-limit" });
  untrackPane(ctx, taskId);
  try {
    await ctx.herdr.request("notification.show", {
      title: "collie",
      body: `${hit.kind} limit hit; queue paused until ${until.toLocaleTimeString()}`,
      sound: "request",
    });
  } catch {
    // best-effort
  }
  return true;
}
