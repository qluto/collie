import { parseArgs } from "node:util";
import {
  HerdrClient, listTasks, loadConfig, markDone, showNotification, teardownTask, type Task,
} from "@collie/core";

/**
 * Where the task id comes from, in order of directness:
 *  1. an explicit argument
 *  2. COLLIE_TASK_ID — set on every pane collie spawns, so `!collie done`
 *     typed into the agent's own input box resolves without help
 *  3. the focused pane — herdr exports HERDR_ACTIVE_PANE_ID to commands bound
 *     via [[keys.command]], and HERDR_PANE_ID inside a pane; the task that owns
 *     that pane is the one on screen
 */
function resolveTaskId(explicit: string | undefined): { id: string } | { error: string } {
  if (explicit) return { id: explicit };
  if (process.env.COLLIE_TASK_ID) return { id: process.env.COLLIE_TASK_ID };

  const paneId = process.env.HERDR_ACTIVE_PANE_ID ?? process.env.HERDR_PANE_ID;
  if (!paneId) {
    return { error: "no task id (pass one, or run this from a task's pane or a herdr keybinding)" };
  }
  const owns = (t: Task) => t.run?.paneId === paneId;
  // Live tasks first: a finished task keeps its paneId, and herdr reuses pane
  // ids, so an old task could otherwise shadow the one actually on screen.
  const live = listTasks({ status: ["running", "blocked", "review"] }).find(owns);
  const hit = live ?? listTasks().find(owns);
  return hit ? { id: hit.id } : { error: `no collie task owns pane ${paneId}` };
}

/**
 * Tick the pane in herdr's sidebar. Unlike a toast this persists, needs no
 * user setting, and marks which panes are finished. Safe: `label` is the pane
 * name only — `agent.list`'s `name` (which must stay unique for agent.start)
 * is a separate field and is untouched by pane.rename.
 */
async function markPaneDone(paneId: string, taskId: string): Promise<void> {
  try {
    const client = new HerdrClient(loadConfig().herdr.socketPath);
    await client.request("pane.rename", { pane_id: paneId, label: `✓ ${taskId}` });
  } catch {
    // decoration is never worth failing the command over
  }
}

function configuredClose(): boolean {
  try {
    return loadConfig().done.close;
  } catch {
    return false; // an invalid config must not make done destructive
  }
}

/**
 * The command's only exit channel. Bound to a herdr key, `collie done` runs
 * detached — stderr goes nowhere — so a failure that does not become a toast
 * is indistinguishable from the key doing nothing at all. Every throw has to
 * come back through here, including one from parsing args or resolving the id
 * (listTasks touches the filesystem and can raise).
 */
async function reportFailure(message: string): Promise<number> {
  console.error(`collie: ${message}`);
  await showNotification(message, "request");
  return 1;
}

/** `collie done [<id>] [--close]` — promote to done from wherever the human is standing. */
export async function runDoneCommand(argv: string[]): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { close: { type: "boolean", default: false } },
      allowPositionals: true,
    });
    const resolved = resolveTaskId(positionals[0]);
    if ("error" in resolved) return await reportFailure(resolved.error);

    const task = markDone(resolved.id, { source: "human-in-pane" });
    console.log(`${task.id} -> done`);

    let closed: string | undefined;
    const wantClose = values.close || configuredClose();
    if (wantClose) {
      closed = await teardownTask(task, new HerdrClient(loadConfig().herdr.socketPath));
      console.log(`  ${closed}`);
    }
    // pointless when the pane just went away with the teardown
    if (!wantClose && task.run?.paneId) await markPaneDone(task.run.paneId, task.id);

    const body = closed ? `${task.title} → done (${closed})` : `${task.title} → done`;
    if (!(await showNotification(body, "done"))) {
      console.log('(herdr toast suppressed — set [ui.toast] delivery = "herdr" to see it)');
    }
    return 0;
  } catch (err) {
    return await reportFailure((err as Error).message);
  }
}
