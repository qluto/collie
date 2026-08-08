import * as path from "node:path";
import { getTask, transition, updateTask } from "@agent-hub/core";
import type { HerdrAgentInfo, Task } from "@agent-hub/core";
import { log, trackPane, untrackPane, type DispatcherCtx } from "./ctx.ts";
import { pointerPrompt, settingsPath, writeRunArtifacts } from "./artifacts.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Find a workspace to spawn into: an existing agent pane with the same cwd wins. */
async function resolveWorkspace(ctx: DispatcherCtx, cwd: string): Promise<string | undefined> {
  const existing = ctx.agents.find((a) => a.cwd === cwd || a.foreground_cwd === cwd);
  if (existing) return existing.workspace_id;
  try {
    const res = await ctx.herdr.request<Record<string, unknown>>("workspace.create", {
      cwd,
      label: cwd.split("/").at(-1),
      focus: false,
    });
    // tolerate shape drift: workspace id may sit at several places
    const ws = res.workspace as Record<string, unknown> | undefined;
    return (res.workspace_id ?? ws?.workspace_id ?? ws?.id ?? res.id) as string | undefined;
  } catch (err) {
    log(ctx, `workspace.create failed for ${cwd}: ${(err as Error).message}; spawning without workspace`);
    return undefined;
  }
}

/** Bump attempts, then requeue (attempts remaining) or fail the task. */
export function requeueOrFail(ctx: DispatcherCtx, taskId: string, reason: string): void {
  const fresh = getTask(taskId);
  if (!fresh) return;
  untrackPane(ctx, taskId);
  if (fresh.status !== "queued" && fresh.status !== "running" && fresh.status !== "blocked") return;
  const attempts = fresh.attempts + 1;
  updateTask(taskId, (t) => {
    t.attempts = attempts;
  });
  if (attempts >= fresh.maxAttempts) {
    transition(taskId, "failed", { failureReason: reason }, { source: "dispatcher" });
    log(ctx, `task ${taskId}: ${reason} -> failed (attempts exhausted ${attempts}/${fresh.maxAttempts})`);
  } else {
    if (fresh.status !== "queued") {
      // clear pane identity: a requeued task must be dispatchable again
      transition(taskId, "queued", { failureReason: reason, paneId: undefined, tabId: undefined, sessionId: undefined }, { source: "dispatcher" });
    } else if (fresh.run?.paneId) {
      updateTask(taskId, (t) => {
        if (t.run) {
          delete t.run.paneId;
          delete t.run.tabId;
          delete t.run.sessionId;
        }
      });
    }
    log(ctx, `task ${taskId}: ${reason} -> queued (attempt ${attempts}/${fresh.maxAttempts})`);
  }
}

interface WorktreeResult {
  path: string;
  workspaceId: string;
}

/**
 * Create (or reopen after a retry) the task's git worktree via Herdr so it
 * shows up as a first-class workspace in the sidebar. worktree.create
 * response includes the new workspace + root pane (verified 0.7.1).
 */
async function ensureWorktree(ctx: DispatcherCtx, task: Task): Promise<WorktreeResult | { error: string }> {
  const wtPath = path.join(
    ctx.config.defaults.worktreeRoot,
    path.basename(task.repo),
    task.id,
  );
  const branch = task.branch ?? `agent-hub/${task.id}`;
  type WtResponse = { workspace?: { workspace_id?: string }; worktree?: { path?: string } };
  try {
    const res = await ctx.herdr.request<WtResponse>("worktree.create", {
      cwd: task.repo, branch, path: wtPath, label: task.id, focus: false,
    });
    if (res.workspace?.workspace_id) {
      return { path: res.worktree?.path ?? wtPath, workspaceId: res.workspace.workspace_id };
    }
    return { error: `worktree.create returned no workspace: ${JSON.stringify(res).slice(0, 120)}` };
  } catch (createErr) {
    // Branch/path may exist from a previous attempt — reopen it.
    try {
      const res = await ctx.herdr.request<WtResponse>("worktree.open", {
        cwd: task.repo, path: wtPath, label: task.id, focus: false,
      });
      if (res.workspace?.workspace_id) return { path: wtPath, workspaceId: res.workspace.workspace_id };
    } catch {
      // fall through to the workspace scan below
    }
    // Already open as a workspace? Find the pane whose cwd is the worktree.
    const existing = ctx.agents.find((a) => a.cwd === wtPath);
    if (existing) return { path: wtPath, workspaceId: existing.workspace_id };
    return { error: `worktree: ${(createErr as Error).message}` };
  }
}

/**
 * Spawn a pane for the task, inject the pointer prompt, mark running.
 * The task stays `queued` until the very last step so a crash mid-dispatch
 * leaves a cleanly redispatable task (half-spawned panes are adopted by
 * reconcile via the session-start hook's paneId write).
 */
export async function dispatchTask(ctx: DispatcherCtx, task: Task): Promise<void> {
  log(ctx, `dispatching ${task.id} "${task.title}" -> ${task.repo}`);
  writeRunArtifacts(task);

  let cwd = task.repo;
  let workspaceId: string | undefined;
  if (task.worktree) {
    const wt = await ensureWorktree(ctx, task);
    if ("error" in wt) {
      requeueOrFail(ctx, task.id, wt.error);
      return;
    }
    cwd = wt.path;
    workspaceId = wt.workspaceId;
    log(ctx, `task ${task.id}: worktree ${cwd} (workspace ${workspaceId})`);
  } else {
    workspaceId = await resolveWorkspace(ctx, cwd);
  }

  let paneId: string;
  let tabId: string | undefined;
  try {
    const res = await ctx.herdr.request<Record<string, unknown>>("agent.start", {
      name: task.id, // agent names must be unique; the task id doubles as a sidebar label
      argv: [
        "claude",
        "--settings", settingsPath(task.id),
        "--permission-mode", task.permissionMode,
        ...task.claudeArgs,
      ],
      cwd,
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
      env: {
        AGENT_HUB_TASK_ID: task.id,
        ...(process.env.AGENT_HUB_HOME ? { AGENT_HUB_HOME: process.env.AGENT_HUB_HOME } : {}),
      },
      focus: false,
    });
    const agent = (res.agent ?? res) as Record<string, unknown>;
    paneId = (agent.pane_id ?? res.pane_id) as string;
    tabId = (agent.tab_id ?? res.tab_id) as string | undefined;
    if (!paneId) throw new Error(`agent.start returned no pane_id: ${JSON.stringify(res)}`);
  } catch (err) {
    requeueOrFail(ctx, task.id, `spawn_failed: ${(err as Error).message}`);
    return;
  }

  const tracker = trackPane(ctx, task.id, paneId);

  // Wait until claude is truly at its input box: agent detection must report a
  // real status ("unknown" covers boot screens and dialogs). The folder-trust
  // dialog is auto-confirmed — queueing a task for a repo IS the trust decision.
  const deadline = Date.now() + ctx.config.dispatch.readyTimeoutSec * 1000;
  let ready = false;
  while (Date.now() < deadline) {
    if (tracker.exited) break;
    // Poll live status only — event-cached status is unreliable during boot
    // (the startup spinner can briefly classify as "working").
    let status: HerdrAgentInfo["agent_status"] | undefined;
    let screen = "";
    try {
      const res = await ctx.herdr.request<Record<string, unknown>>("agent.get", { target: paneId });
      status = ((res.agent ?? res) as HerdrAgentInfo).agent_status;
      const read = await ctx.herdr.request<Record<string, unknown>>("pane.read", {
        pane_id: paneId, source: "visible", lines: 40,
      });
      screen = extractText(read);
    } catch {
      // not detected / not readable yet
    }
    if (/Yes, I trust this folder/.test(screen)) {
      // Startup dialogs read as "blocked"; queueing a task for a repo IS the
      // trust decision, so confirm and keep waiting for the input box.
      log(ctx, `task ${task.id}: confirming folder-trust dialog in ${paneId}`);
      await ctx.herdr.request("pane.send_keys", { pane_id: paneId, keys: ["Enter"] });
    } else if (status === "idle") {
      tracker.lastStatus = status;
      ready = true;
      break;
    }
    await sleep(2000);
  }
  if (!ready) {
    requeueOrFail(ctx, task.id, "spawn_timeout");
    return;
  }
  // Give claude's input box a beat to accept text after detection.
  await sleep(1500);

  // Inject the one-line pointer; verify it landed before pressing Enter.
  const pointer = pointerPrompt(task.id);
  let injected = false;
  for (let attempt = 0; attempt < 3 && !injected; attempt++) {
    try {
      await ctx.herdr.request("agent.send", { target: paneId, text: pointer });
      await sleep(500);
      const read = await ctx.herdr.request<Record<string, unknown>>("pane.read", {
        pane_id: paneId,
        source: "visible",
        lines: 40,
      });
      // The pane hard-wraps long lines; compare with all whitespace stripped.
      const text = extractText(read).replace(/\s+/g, "");
      if (text.includes(`runs/${task.id}/prompt.md`.replace(/\s+/g, ""))) injected = true;
    } catch (err) {
      log(ctx, `inject attempt ${attempt + 1} failed for ${task.id}: ${(err as Error).message}`);
      await sleep(1000);
    }
  }
  if (!injected) {
    requeueOrFail(ctx, task.id, "inject_failed");
    return;
  }
  await ctx.herdr.request("pane.send_keys", { pane_id: paneId, keys: ["Enter"] });

  transition(
    task.id,
    "running",
    { paneId, tabId, workspaceId, ...(task.worktree ? { worktreePath: cwd } : {}) },
    { source: "dispatcher" },
  );
  await reportStatus(ctx, task.id, paneId, `agent-hub ▶ ${task.title}`);
  log(ctx, `task ${task.id} running in pane ${paneId}`);
}

/**
 * Push a status line into Herdr's sidebar for the pane. Deliberately uses only
 * pane.report_metadata (display channel), never pane.report_agent: reporting a
 * semantic state would feed back into the agent_status we ourselves read for
 * scheduling decisions.
 */
export async function reportStatus(ctx: DispatcherCtx, taskId: string, paneId: string, text: string): Promise<void> {
  try {
    const fresh = getTask(taskId);
    const seq = (fresh?.run?.reportSeq ?? 0) + 1;
    updateTask(taskId, (t) => {
      t.run = { ...t.run, reportSeq: seq };
    });
    await ctx.herdr.request("pane.report_metadata", {
      pane_id: paneId,
      source: "agent-hub",
      custom_status: text,
      seq,
    });
  } catch {
    // sidebar decoration is best-effort
  }
}

/** pane.read result shape (verified 0.7.1): { type: "pane_read", read: { text } } */
export function extractText(readResult: Record<string, unknown>): string {
  const read = readResult.read as Record<string, unknown> | undefined;
  if (read && typeof read.text === "string") return read.text;
  if (typeof readResult.text === "string") return readResult.text;
  return "";
}
