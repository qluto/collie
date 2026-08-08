import * as fs from "node:fs";
import {
  dispatcherStatePath, ensureDataDirs, listTasks, loadConfig,
  type DispatcherState, type Task,
} from "@agent-hub/core";
import { createCtx, log, vlog, type DispatcherCtx } from "./ctx.ts";
import { dispatchTask } from "./dispatch.ts";
import { reconcile } from "./reconcile.ts";
import { watchdog } from "./watchdog.ts";

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

function writeState(ctx: DispatcherCtx, wip: number): void {
  const state: DispatcherState = {
    pid: process.pid,
    startedAt: ctx.startedAt,
    lastTickAt: new Date().toISOString(),
    mode: ctx.degraded ? "degraded" : "full", // schedule modes land in Phase 2
    wip,
    lastDecision: ctx.lastDecision,
  };
  fs.writeFileSync(dispatcherStatePath(), JSON.stringify(state, null, 2));
}

/** Phase 1 gate: WIP limit only. Schedule/quota gates arrive in Phase 2. */
function pickCandidate(ctx: DispatcherCtx): { task?: Task; decision: string } {
  const wipTasks = listTasks({ status: ["running", "blocked"] });
  const wip = wipTasks.length;
  if (wip >= ctx.config.dispatch.wipLimit) {
    return { decision: `wip full (${wip}/${ctx.config.dispatch.wipLimit})` };
  }
  const queued = listTasks({ status: ["queued"] }).filter((t) => !t.run?.paneId);
  const task = queued[0];
  if (!task) return { decision: `queue empty (wip ${wip}/${ctx.config.dispatch.wipLimit})` };
  return { task, decision: `dispatching ${task.id}` };
}

export async function tick(ctx: DispatcherCtx): Promise<void> {
  await reconcile(ctx);
  await watchdog(ctx);

  if (ctx.degraded) {
    ctx.lastDecision = "degraded: herdr socket unreachable";
  } else {
    const { task, decision } = pickCandidate(ctx);
    ctx.lastDecision = decision;
    if (task) await dispatchTask(ctx, task);
  }

  const wip = listTasks({ status: ["running", "blocked"] }).length;
  writeState(ctx, wip);
  vlog(ctx, `tick: ${ctx.lastDecision} (wip ${wip})`);
}

export async function runDispatcher(opts: { once?: boolean; verbose?: boolean }): Promise<number> {
  ensureDataDirs();
  const config = loadConfig();

  const existing = readState();
  if (existing && existing.pid !== process.pid && pidAlive(existing.pid)) {
    console.error(`agent-hub dispatcher already running (pid ${existing.pid})`);
    return 1;
  }

  const ctx = createCtx(config, opts.verbose ?? false);
  log(ctx, `dispatcher started (pid ${process.pid}, poll ${config.dispatch.pollIntervalSec}s, wip ${config.dispatch.wipLimit})`);

  let stopping = false;
  const stop = () => {
    stopping = true;
    log(ctx, "dispatcher stopping");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  do {
    try {
      await tick(ctx);
    } catch (err) {
      log(ctx, `tick error: ${(err as Error).stack ?? err}`);
    }
    if (!opts.once && !stopping) await sleep(config.dispatch.pollIntervalSec * 1000);
  } while (!opts.once && !stopping);

  for (const [taskId] of ctx.panes) ctx.panes.get(taskId)?.sub?.close();
  return 0;
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
