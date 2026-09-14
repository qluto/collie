import * as path from "node:path";
import {
  HerdrError, announceStart, getTask, headCommit, reportTaskMetadata, resolveWorktreeBase,
  runPostCreate, runsDir, transition, updateTask, worktreeSettingsFor,
} from "@collie/core";
import type { Task } from "@collie/core";
import { log, trackPane, untrackPane, type DispatcherCtx } from "./ctx.ts";
import { pointerPrompt, settingsPath, writeRunArtifacts } from "./artifacts.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Where the agent will live. Herdr 0.8.0's `agent.start` CREATES NO LAYOUT —
 * it adopts a shell pane already sitting at its prompt — and carries neither
 * cwd nor env, so the pane must be born with both.
 *
 * `readyPaneId` is a pane we made WITH the task's cwd+env: use it as is.
 * `ownedRootPaneId` is the bare shell a workspace we created came with, which
 * has the cwd but not the env — ours to close once the task's own pane exists.
 * A workspace we merely found (a human's, or a reopened worktree) contributes
 * neither: nothing in it is ours to reuse or to close.
 */
interface SpawnTarget {
  workspaceId?: string;
  readyPaneId?: string;
  ownedRootPaneId?: string;
  tabId?: string;
}

/** Find a workspace to spawn into: an existing agent pane with the same cwd wins. */
async function resolveWorkspace(
  ctx: DispatcherCtx,
  cwd: string,
  env: Record<string, string>,
): Promise<SpawnTarget> {
  const existing = ctx.agents.find((a) => a.cwd === cwd || a.foreground_cwd === cwd);
  if (existing) return { workspaceId: existing.workspace_id }; // someone else's pane: leave it alone
  try {
    const res = await ctx.herdr.request<Record<string, unknown>>("workspace.create", {
      cwd,
      label: cwd.split("/").at(-1),
      env,
      focus: false,
    });
    // tolerate shape drift: workspace id may sit at several places
    const ws = res.workspace as Record<string, unknown> | undefined;
    return {
      workspaceId: (res.workspace_id ?? ws?.workspace_id ?? ws?.id ?? res.id) as string | undefined,
      // born with our cwd AND our env: this is the task's pane
      readyPaneId: rootPaneOf(res),
      tabId: tabOf(res),
    };
  } catch (err) {
    log(ctx, `workspace.create failed for ${cwd}: ${(err as Error).message}; spawning without workspace`);
    return {};
  }
}

function rootPaneOf(res: Record<string, unknown>): string | undefined {
  const pane = res.root_pane as Record<string, unknown> | undefined;
  return pane?.pane_id as string | undefined;
}

function tabOf(res: Record<string, unknown>): string | undefined {
  const tab = res.tab as Record<string, unknown> | undefined;
  return tab?.tab_id as string | undefined;
}

/**
 * The pane the agent gets adopted into. `tab.create` is the only way to add one
 * to a workspace we did not create without touching a pane that may be a
 * human's — and unlike `worktree.create` it takes both cwd and env.
 */
async function createTaskPane(
  ctx: DispatcherCtx,
  task: Task,
  cwd: string,
  env: Record<string, string>,
  target: SpawnTarget,
): Promise<{ paneId: string; tabId?: string }> {
  if (target.readyPaneId) return { paneId: target.readyPaneId, tabId: target.tabId };
  const res = await ctx.herdr.request<Record<string, unknown>>("tab.create", {
    ...(target.workspaceId ? { workspace_id: target.workspaceId } : {}),
    cwd,
    env,
    label: task.id,
    focus: false,
  });
  const paneId = rootPaneOf(res);
  if (!paneId) throw new Error(`tab.create returned no root pane: ${JSON.stringify(res).slice(0, 120)}`);
  return { paneId, tabId: tabOf(res) };
}

/**
 * Free the agent name before requeueing. `agent.start` names are server-unique
 * and the task id doubles as the name, so a pane left behind by a failed
 * dispatch makes EVERY retry die with agent_name_taken — the task then burns
 * all its attempts without ever running. These panes never received a prompt,
 * so there is nothing to inspect (unlike a cancelled task's live pane).
 */
async function closeHalfSpawnedPane(ctx: DispatcherCtx, taskId: string, paneId: string): Promise<void> {
  try {
    await ctx.herdr.request("pane.close", { pane_id: paneId });
    log(ctx, `task ${taskId}: closed half-spawned pane ${paneId}`);
  } catch (err) {
    log(ctx, `task ${taskId}: pane.close ${paneId} failed: ${(err as Error).message}`);
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
  branch: string;
  workspaceId: string;
  rootPaneId?: string;
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
  const branch = task.branch ?? `collie/${task.id}`;
  // Resolved HERE, not at task creation: the whole value of the base is that it
  // was fetched moments ago. A task queued at 18:00 and dispatched at 03:00
  // would otherwise fork from what origin looked like before dinner.
  const wt = worktreeSettingsFor(ctx.config, task.repo);
  const base = await resolveWorktreeBase(task.repo, wt);
  log(ctx, base
    ? `task ${task.id}: forking ${branch} from ${base.note}`
    : `task ${task.id}: origin/HEAD unset and no [worktree] base — forking from HEAD`);
  type WtResponse = {
    workspace?: { workspace_id?: string };
    worktree?: { path?: string };
    root_pane?: { pane_id?: string };
  };
  try {
    const res = await ctx.herdr.request<WtResponse>("worktree.create", {
      cwd: task.repo, branch, path: wtPath, label: task.id, focus: false,
      // create only: worktree.open reopens a checkout that already forked.
      ...(base ? { base: base.ref } : {}),
    });
    if (res.workspace?.workspace_id) {
      return {
        path: res.worktree?.path ?? wtPath,
        branch,
        workspaceId: res.workspace.workspace_id,
        rootPaneId: res.root_pane?.pane_id,
      };
    }
    return { error: `worktree.create returned no workspace: ${JSON.stringify(res).slice(0, 120)}` };
  } catch (createErr) {
    // Branch/path may exist from a previous attempt — reopen it.
    try {
      const res = await ctx.herdr.request<WtResponse>("worktree.open", {
        cwd: task.repo, path: wtPath, label: task.id, focus: false,
      });
      // No rootPaneId here on purpose: reopening can hand back a workspace that
      // was already open, whose root pane may be one a human is using. Only a
      // pane we just created is ours to close.
      if (res.workspace?.workspace_id) return { path: wtPath, branch, workspaceId: res.workspace.workspace_id };
    } catch {
      // fall through to the workspace scan below
    }
    // Already open as a workspace? Find the pane whose cwd is the worktree.
    const existing = ctx.agents.find((a) => a.cwd === wtPath);
    if (existing) return { path: wtPath, branch, workspaceId: existing.workspace_id };
    return { error: `worktree: ${(createErr as Error).message}` };
  }
}

/**
 * The claude flags a task launches with. `claudeArgs` stays LAST so an explicit
 * flag can still override what the task's own fields asked for; an unset model
 * passes no flag at all, which is how claude picks its own default.
 */
export function claudeArgsFor(task: Task): string[] {
  return [
    "--settings", settingsPath(task.id),
    "--permission-mode", task.permissionMode,
    ...(task.model ? ["--model", task.model] : []),
    ...task.claudeArgs,
  ];
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
  const env: Record<string, string> = {
    COLLIE_TASK_ID: task.id,
    ...(process.env.COLLIE_HOME ? { COLLIE_HOME: process.env.COLLIE_HOME } : {}),
  };

  let target: SpawnTarget;
  if (task.worktree) {
    const wt = await ensureWorktree(ctx, task);
    if ("error" in wt) {
      requeueOrFail(ctx, task.id, wt.error);
      return;
    }
    cwd = wt.path;

    // Before the agent, never after: a session started on a checkout missing
    // its .env burns the night discovering that. Runs on the reopen path too,
    // which is why the config asks for an idempotent script.
    const settings = worktreeSettingsFor(ctx.config, task.repo);
    const hook = await runPostCreate({
      script: settings.postCreate,
      timeoutSec: settings.postCreateTimeoutSec,
      cwd,
      env: {
        COLLIE_REPO: task.repo,
        COLLIE_WORKTREE: cwd,
        COLLIE_BRANCH: wt.branch,
        COLLIE_TASK_ID: task.id,
      },
      logPath: path.join(runsDir(task.id), "post_create.log"),
    });
    if (!hook.ok) {
      if (wt.rootPaneId) await closeHalfSpawnedPane(ctx, task.id, wt.rootPaneId);
      requeueOrFail(ctx, task.id, hook.reason ?? "post_create failed");
      return;
    }

    // worktree.create takes neither cwd nor env for its shell, so its root pane
    // can never be the task's pane — a tab of our own gets both.
    target = { workspaceId: wt.workspaceId, ownedRootPaneId: wt.rootPaneId };
    log(ctx, `task ${task.id}: worktree ${cwd} (workspace ${wt.workspaceId})`);
  } else {
    target = await resolveWorkspace(ctx, cwd, env);
  }
  const workspaceId = target.workspaceId;

  let paneId: string;
  let tabId: string | undefined;
  try {
    ({ paneId, tabId } = await createTaskPane(ctx, task, cwd, env, target));
  } catch (err) {
    requeueOrFail(ctx, task.id, `pane_failed: ${(err as Error).message}`);
    return;
  }
  // The bare shell a workspace we created came with has served its purpose.
  if (target.ownedRootPaneId && target.ownedRootPaneId !== paneId) {
    try {
      await ctx.herdr.request("pane.close", { pane_id: target.ownedRootPaneId });
    } catch (closeErr) {
      log(ctx, `task ${task.id}: could not close root pane ${target.ownedRootPaneId}: ${(closeErr as Error).message}`);
    }
  }

  const tracker = trackPane(ctx, task.id, paneId);

  // agent.start launches claude in that pane and returns only once herdr sees
  // it interactive, so the old poll-for-idle loop is gone — but the readiness
  // it waits for is exactly what the folder-trust dialog withholds, hence the
  // concurrent watcher.
  const readyMs = ctx.config.dispatch.readyTimeoutSec * 1000;
  const deadline = Date.now() + readyMs;
  for (;;) {
    try {
      await ctx.herdr.request("agent.start", {
        name: task.id, // names must be unique among live agents; the id doubles as a sidebar label
        kind: "claude",
        pane_id: paneId,
        // native claude flags: 0.8.0 launches the agent itself, argv is gone
        args: claudeArgsFor(task),
        timeout_ms: readyMs,
      }, { timeoutMs: readyMs + 15_000 });
      break;
    } catch (err) {
      // A pane counts as "an available shell" only once its login shell has
      // reached its prompt — a fat zshrc takes a beat, and agent.start refuses
      // with agent_pane_busy until then. Retry instead of guessing a delay.
      if ((err as HerdrError).code === "agent_pane_busy" && Date.now() < deadline && !tracker.exited) {
        await sleep(1000);
        continue;
      }
      await closeHalfSpawnedPane(ctx, task.id, paneId);
      requeueOrFail(ctx, task.id, `spawn_failed: ${(err as Error).message}`);
      return;
    }
  }

  // agent.start returns as soon as the launch is under way, so readiness is
  // still ours to establish. Readiness is `interactive_ready` on an agent
  // record carrying OUR name — that is exactly what agent.prompt demands
  // ("not an active named agent" otherwise). Never `agent_status`: it is
  // screen-scraped, and a pane whose shell is merely idle reads idle too. The
  // folder-trust dialog is answered here: queueing a task for a repo IS the
  // trust decision.
  let ready = false;
  while (Date.now() < deadline && !tracker.exited) {
    let info: { name?: string; interactive_ready?: boolean } = {};
    let screen = "";
    try {
      const res = await ctx.herdr.request<Record<string, unknown>>("agent.get", { target: paneId });
      info = (res.agent ?? res) as typeof info;
      const read = await ctx.herdr.request<Record<string, unknown>>("pane.read", {
        pane_id: paneId, source: "visible", lines: 40,
      });
      screen = extractText(read);
    } catch {
      // not detected / not readable yet
    }
    if (/Yes, I trust this folder/.test(screen)) {
      log(ctx, `task ${task.id}: confirming folder-trust dialog in ${paneId}`);
      await ctx.herdr.request("pane.send_keys", { pane_id: paneId, keys: ["Enter"] });
    } else if (info.name === task.id && info.interactive_ready === true) {
      ready = true;
      break;
    }
    await sleep(2000);
  }
  if (!ready) {
    await closeHalfSpawnedPane(ctx, task.id, paneId);
    requeueOrFail(ctx, task.id, "spawn_timeout");
    return;
  }
  // Give claude's input box a beat to accept text after detection.
  await sleep(1500);

  // One atomic submit: agent.prompt sends the text AND the encoded Enter,
  // honouring the pane's live bracketed-paste mode, so the send → read back →
  // press Enter dance (and its whitespace-stripped echo check) is gone. Retried
  // only for agent_not_ready — the registration can lag the readiness flag by a
  // beat, and every other error means this pane is not going to take a prompt.
  let injected = false;
  for (let attempt = 0; attempt < 3 && !injected; attempt++) {
    try {
      await ctx.herdr.request("agent.prompt", { target: paneId, text: pointerPrompt(task.id) });
      injected = true;
    } catch (err) {
      log(ctx, `task ${task.id}: agent.prompt attempt ${attempt + 1} failed: ${(err as Error).message}`);
      if ((err as HerdrError).code !== "agent_not_ready") break;
      await sleep(1500);
    }
  }
  if (!injected) {
    await closeHalfSpawnedPane(ctx, task.id, paneId);
    requeueOrFail(ctx, task.id, "inject_failed");
    return;
  }

  // The fresh checkout's HEAD is the branch's fork point. Recorded now because
  // afterwards there is nothing left to compare against: a branch that never
  // got a commit and one whose commits were merged both read as "contained in
  // HEAD" (see branches.ts).
  const base = task.worktree ? headCommit(cwd) : null;
  transition(
    task.id,
    "running",
    {
      paneId, tabId, workspaceId,
      ...(task.worktree ? { worktreePath: cwd } : {}),
      ...(base ? { baseCommit: base } : {}),
    },
    { source: "dispatcher" },
  );
  await reportStatus(ctx, task.id, paneId, "▶ running");
  log(ctx, `task ${task.id} running in pane ${paneId}`);

  // Everything a task's origin is owed once it is actually running — and no
  // earlier, since a queued task may sit all evening behind presence or the
  // quota gate. After the transition, and behind its own catch: the session is
  // up, and a third-party API must not be able to unmake that.
  try {
    for (const w of await announceStart(ctx.config.linear, task.origin, task.id, task.branch)) {
      log(ctx, `linear: ${w}`);
    }
  } catch (err) {
    log(ctx, `linear: announce failed for ${task.id} (${(err as Error).message})`);
  }
}

/** Thin wrapper over core's reporter: the dispatcher owns the client, not the shape. */
export async function reportStatus(ctx: DispatcherCtx, taskId: string, paneId: string, status: string): Promise<void> {
  await reportTaskMetadata(ctx.herdr, taskId, paneId, status);
}

/** pane.read result shape (verified 0.7.1): { type: "pane_read", read: { text } } */
export function extractText(readResult: Record<string, unknown>): string {
  const read = readResult.read as Record<string, unknown> | undefined;
  if (read && typeof read.text === "string") return read.text;
  if (typeof readResult.text === "string") return readResult.text;
  return "";
}
