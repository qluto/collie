import * as fs from "node:fs";
import {
  ConfigError, decideDrift, dispatcherStatePath, ensureDataDirs, installCommit, listTasks,
  loadConfig, refreshLimits, refreshUpdateCheck, shortSha, syncLinear, underLaunchd,
  updateAvailable, updateTask, type DispatcherState, type ScheduleMode,
} from "@collie/core";
import { adoptMerged } from "./adopt.ts";
import { keepAwake } from "./awake.ts";
import { createCtx, log, vlog, type DispatcherCtx } from "./ctx.ts";
import { dispatchTask } from "./dispatch.ts";
import { checkPullRequests } from "./pr.ts";
import { reconcile } from "./reconcile.ts";
import { watchdog } from "./watchdog.ts";
import { planTick } from "./gates.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readState(): DispatcherState | null {
  try {
    return JSON.parse(fs.readFileSync(dispatcherStatePath(), "utf8")) as DispatcherState;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeState(ctx: DispatcherCtx, wip: number, mode: ScheduleMode | "degraded"): void {
  const state: DispatcherState = {
    pid: process.pid,
    startedAt: ctx.startedAt,
    lastTickAt: new Date().toISOString(),
    mode,
    wip,
    lastDecision: ctx.lastDecision,
    ...(ctx.bootCommit ? { commit: ctx.bootCommit } : {}),
  };
  fs.writeFileSync(dispatcherStatePath(), JSON.stringify(state, null, 2));
}

export async function tick(ctx: DispatcherCtx): Promise<void> {
  // Config edits (TUI/editor) apply on the next tick without a restart.
  try {
    ctx.config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) log(ctx, `config invalid, keeping previous: ${err.message}`);
    else throw err;
  }

  // Real limit percentages, at most one call per 10 minutes (the module caches
  // to disk, so the TUI reads the same snapshot instead of polling separately).
  const limits = await refreshLimits();
  if (limits.skipped && limits.skipped !== ctx.lastLimitsSkip) {
    log(ctx, `limits: ${limits.skipped}; falling back to ccusage estimates`);
  }
  ctx.lastLimitsSkip = limits.skipped;

  // Is there a newer collie? Once a day, read-only (ls-remote), never throws.
  // Only ever a log line here: an unattended process does not move its own code.
  await checkForUpdate(ctx);

  // New work from outside, on its own much slower clock (the module throttles
  // itself). A third-party API being down is a log line, never a tick that
  // stops: everything below still has a night to run.
  try {
    const sync = await syncLinear(ctx.config);
    for (const id of sync.created) log(ctx, `linear: imported ${id}`);
    for (const w of sync.warnings) log(ctx, `linear: ${w}`);
  } catch (err) {
    if (ctx.lastLinearError !== (err as Error).message) {
      log(ctx, `linear: ${(err as Error).message}`);
      ctx.lastLinearError = (err as Error).message;
    }
  }

  await reconcile(ctx);
  await watchdog(ctx);
  // Driven by git, not herdr: a human merging a branch is a completion signal
  // the socket never carries. Also refreshes the scan the TUI's dropped list
  // reads.
  await adoptMerged(ctx);
  // After adoption, so a task that just landed and was archived is not asked
  // about: updateTask cannot reach an archived file.
  await checkPullRequests(ctx);

  let mode: ScheduleMode | "degraded" = "degraded";
  if (ctx.degraded) {
    ctx.lastDecision = "degraded: herdr socket unreachable";
  } else {
    const plan = planTick(ctx);
    mode = plan.mode;
    ctx.lastDecision = plan.decision;
    if (plan.task) {
      // One-shot: a start-now that fails requeues as ordinary queued work
      // instead of bypassing the gates on every retry.
      if (plan.task.startNow) updateTask(plan.task.id, (t) => { delete t.startNow; }, { source: "dispatcher" });
      await dispatchTask(ctx, plan.task);
    }
  }

  const wip = listTasks({ status: ["running"] }).length;
  writeState(ctx, wip, mode);
  vlog(ctx, `tick: ${ctx.lastDecision} (wip ${wip})`);

  // LAST, after the state write: a tick boundary is never mid-dispatch, so
  // this is the one place exiting for new code loses nothing.
  checkDrift(ctx);
}

async function checkForUpdate(ctx: DispatcherCtx): Promise<void> {
  try {
    const check = await refreshUpdateCheck(ctx.config);
    if (!check) return;
    if (check.error && check.error !== ctx.lastUpdateError) log(ctx, `update check: ${check.error}`);
    ctx.lastUpdateError = check.error;
    const latest = updateAvailable(check);
    if (latest && latest !== ctx.lastUpdateNotice) {
      log(ctx, `update: ${latest} is available (running ${check.current ?? "an untagged checkout"}) — run \`collie update\``);
    }
    ctx.lastUpdateNotice = latest ?? undefined;
  } catch (err) {
    // refreshUpdateCheck is built not to throw; this is the belt to its braces
    log(ctx, `update check: ${(err as Error).message}`);
  }
}

/**
 * Hooks and the CLI load fresh source on every call; this process loaded its
 * modules once. After a `git pull` the two disagree silently — so the launchd
 * job exits (non-zero, via the stop path) and KeepAlive brings it back on the
 * new code. A manual run has nobody to restart it, so it only says so.
 */
function checkDrift(ctx: DispatcherCtx): void {
  const disk = installCommit();
  const decision = decideDrift({
    bootCommit: ctx.bootCommit,
    diskCommit: disk,
    previousDiskCommit: ctx.lastDiskCommit,
    underLaunchd: ctx.launchd,
  });
  ctx.lastDiskCommit = disk;
  if (decision.action === "restart") {
    ctx.restartReason = `code changed ${shortSha(decision.from)} → ${shortSha(decision.to)}, restarting`;
  } else if (decision.action === "report" && ctx.reportedDrift !== decision.to) {
    log(ctx, `code changed ${shortSha(decision.from)} → ${shortSha(decision.to)} on disk; this dispatcher still runs the old code — restart it to pick that up`);
    ctx.reportedDrift = decision.to;
  }
}

export async function runDispatcher(opts: {
  once?: boolean;
  verbose?: boolean;
  /**
   * Whether this process is the launchd job (may exit to pick up new code).
   * Detected from the environment; injectable because XPC_SERVICE_NAME cannot
   * be faked — libxpc aborts any process that sets it outside launchd.
   */
  launchd?: boolean;
}): Promise<number> {
  ensureDataDirs();
  const config = loadConfig();

  const existing = readState();
  if (existing && existing.pid !== process.pid && pidAlive(existing.pid)) {
    console.error(`collie dispatcher already running (pid ${existing.pid})`);
    return 1;
  }

  const ctx = createCtx(config, opts.verbose ?? false, installCommit());
  ctx.launchd = opts.launchd ?? underLaunchd();
  log(ctx, `dispatcher started (pid ${process.pid}, poll ${config.dispatch.pollIntervalSec}s, wip ${config.dispatch.wipLimit}, code ${shortSha(ctx.bootCommit)})`);

  // Released on the way out below; a stop we never see is what `-w` is for.
  const releaseAwake = !opts.once && config.dispatch.keepAwake ? keepAwake((m) => log(ctx, m)) : null;

  let stopping = false;
  let wakeUp: (() => void) | undefined;
  const stop = () => {
    stopping = true;
    log(ctx, "dispatcher stopping");
    wakeUp?.(); // interrupt the inter-tick sleep for a prompt exit
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  do {
    try {
      await tick(ctx);
    } catch (err) {
      log(ctx, `tick error: ${(err as Error).stack ?? err}`);
    }
    if (ctx.restartReason && !stopping) {
      log(ctx, ctx.restartReason);
      stop(); // non-zero exit below: KeepAlive restarts only an unsuccessful one
    }
    if (!opts.once && !stopping) {
      await new Promise<void>((resolve) => {
        wakeUp = resolve;
        setTimeout(resolve, ctx.config.dispatch.pollIntervalSec * 1000);
      });
      wakeUp = undefined;
    }
  } while (!opts.once && !stopping);

  for (const [taskId] of ctx.panes) ctx.panes.get(taskId)?.sub?.close();
  releaseAwake?.();
  // Signal-initiated stop exits non-zero so launchd's KeepAlive
  // (SuccessfulExit=false) restarts us after an accidental kill; launchctl
  // bootout unloads regardless of exit code, so uninstall still sticks.
  return stopping ? 1 : 0;
}

export function dispatcherStatus(): number {
  const state = readState();
  if (!state) {
    console.log("dispatcher: not running (no state file)");
    return 1;
  }
  const alive = pidAlive(state.pid);
  const age = Math.round((Date.now() - Date.parse(state.lastTickAt)) / 1000);
  console.log(`dispatcher: ${alive ? "running" : "DEAD"} (pid ${state.pid})`);
  console.log(`  mode:         ${state.mode}`);
  console.log(`  last tick:    ${state.lastTickAt} (${age}s ago)`);
  console.log(`  wip:          ${state.wip}`);
  console.log(`  lastDecision: ${state.lastDecision}`);
  const disk = installCommit();
  const code = !state.commit
    ? "unknown (dispatcher predates commit tracking)"
    : !disk || disk === state.commit
      ? shortSha(state.commit)
      : `${shortSha(state.commit)} — checkout is at ${shortSha(disk)}: running OLD code (the launchd job restarts itself within two ticks; a manual run must be restarted by hand)`;
  console.log(`  code:         ${code}`);
  const counts = new Map<string, number>();
  for (const t of listTasks()) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  console.log(`  tasks:        ${[...counts.entries()].map(([k, v]) => `${k}=${v}`).join(" ") || "(none)"}`);
  return alive ? 0 : 1;
}
