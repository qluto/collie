import * as fs from "node:fs";
import {
  ConfigError, dispatcherStatePath, ensureDataDirs, listTasks, loadConfig,
  type DispatcherState, type ScheduleMode,
} from "@collie/core";
import { createCtx, log, vlog, type DispatcherCtx } from "./ctx.ts";
import { dispatchTask } from "./dispatch.ts";
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

  await reconcile(ctx);
  await watchdog(ctx);

  let mode: ScheduleMode | "degraded" = "degraded";
  if (ctx.degraded) {
    ctx.lastDecision = "degraded: herdr socket unreachable";
  } else {
    const plan = planTick(ctx);
    mode = plan.mode;
    ctx.lastDecision = plan.decision;
    if (plan.task) await dispatchTask(ctx, plan.task);
  }

  const wip = listTasks({ status: ["running", "blocked"] }).length;
  writeState(ctx, wip, mode);
  vlog(ctx, `tick: ${ctx.lastDecision} (wip ${wip})`);
}

export async function runDispatcher(opts: { once?: boolean; verbose?: boolean }): Promise<number> {
  ensureDataDirs();
  const config = loadConfig();

  const existing = readState();
  if (existing && existing.pid !== process.pid && pidAlive(existing.pid)) {
    console.error(`collie dispatcher already running (pid ${existing.pid})`);
    return 1;
  }

  const ctx = createCtx(config, opts.verbose ?? false);
  log(ctx, `dispatcher started (pid ${process.pid}, poll ${config.dispatch.pollIntervalSec}s, wip ${config.dispatch.wipLimit})`);

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
    if (!opts.once && !stopping) {
      await new Promise<void>((resolve) => {
        wakeUp = resolve;
        setTimeout(resolve, ctx.config.dispatch.pollIntervalSec * 1000);
      });
      wakeUp = undefined;
    }
  } while (!opts.once && !stopping);

  for (const [taskId] of ctx.panes) ctx.panes.get(taskId)?.sub?.close();
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
  const counts = new Map<string, number>();
  for (const t of listTasks()) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  console.log(`  tasks:        ${[...counts.entries()].map(([k, v]) => `${k}=${v}`).join(" ") || "(none)"}`);
  return alive ? 0 : 1;
}
