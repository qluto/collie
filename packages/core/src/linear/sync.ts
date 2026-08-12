import * as fs from "node:fs";
import { ensureDataDirs, linearStatePath } from "../paths.ts";
import { discoverRepos, repoProblem } from "../repos.ts";
import { createTask, listTasks } from "../store.ts";
import type { Config, TaskOrigin } from "../types.ts";
import {
  LinearError, commentOnIssue, fetchIssue, fetchLabeledIssues, fetchWorkflowStates, moveIssueToState,
  readApiKey,
} from "./api.ts";
import type { LinearIssue } from "./api.ts";
import { pickStartState, planImport, type PlanEntry } from "./plan.ts";

/**
 * The import ledger. Dedup could be re-derived by scanning every task's
 * `origin`, but the archive only ever grows and this runs on a timer, so the
 * answer is kept in one small file — the same shape as limits.json. It is a
 * cache in front of the tasks, not a second truth: losing it re-imports at
 * worst the issues Linear also still reports as unstarted.
 */
export interface LinearState {
  lastSyncAt?: number;
  imported: Record<string, { taskId: string; ref: string; at: string }>;
}

const EMPTY: LinearState = { imported: {} };

export function readLinearState(): LinearState {
  try {
    const parsed = JSON.parse(fs.readFileSync(linearStatePath(), "utf8")) as Partial<LinearState>;
    return { lastSyncAt: parsed.lastSyncAt, imported: parsed.imported ?? {} };
  } catch {
    return { ...EMPTY, imported: {} };
  }
}

function writeLinearState(state: LinearState): void {
  ensureDataDirs();
  fs.writeFileSync(linearStatePath(), JSON.stringify(state, null, 2));
}

export interface SyncResult {
  /** set when nothing was attempted, and why — never an error */
  skipped?: string;
  /** what the poll decided, import and skip alike */
  entries: PlanEntry[];
  /** collie task ids created */
  created: string[];
  /** non-fatal problems: an issue that imported but could not be written back */
  warnings: string[];
}

const idle = (skipped: string): SyncResult => ({ skipped, entries: [], created: [], warnings: [] });

/**
 * Tell Linear that work on this issue has actually STARTED.
 *
 * Deliberately not at import time. Importing only means the issue reached
 * collie's queue, where it may sit all evening behind presence, the WIP limit
 * or the quota gate — an issue sitting in "In Progress" for hours while
 * nothing is running is the board telling a lie. This fires from the
 * dispatcher, right after the task transitions to running.
 *
 * Best-effort by construction: the session is already up, so nothing here may
 * undo it or throw into the dispatch path. Failures come back as warnings.
 * The issue's state is re-READ rather than remembered — the import snapshot is
 * hours old by now and someone may have moved it in the meantime.
 */
export async function announceStart(
  cfg: Config["linear"],
  origin: TaskOrigin | undefined,
  taskId: string,
  branch?: string,
): Promise<string[]> {
  if (!cfg.enabled || origin?.kind !== "linear") return [];
  const key = readApiKey();
  if (!key) return [`${origin.ref}: started, but there is no API key to say so`];

  const warnings: string[] = [];
  let issue: LinearIssue | null = null;
  try {
    issue = await fetchIssue(key, origin.id);
  } catch (err) {
    return [`${origin.ref}: could not read the issue (${(err as Error).message})`];
  }
  if (!issue) return [`${origin.ref}: issue is gone from Linear`];

  try {
    const states = await fetchWorkflowStates(key, issue.team.id);
    const target = pickStartState(states, cfg.startState);
    if (!target) {
      warnings.push(
        `${origin.ref}: no ${cfg.startState || "started"} state on team ${issue.team.key}; left as is`,
      );
    } else if (target.id !== issue.state.id) {
      await moveIssueToState(key, issue.id, target.id);
    }
  } catch (err) {
    warnings.push(`${origin.ref}: could not move state (${(err as Error).message})`);
  }

  if (cfg.comment) {
    const where = branch ? ` on \`${branch}\`` : "";
    try {
      await commentOnIssue(key, issue.id, `Started by collie as \`${taskId}\`${where}.`);
    } catch (err) {
      warnings.push(`${origin.ref}: could not comment (${(err as Error).message})`);
    }
  }
  return warnings;
}

/**
 * One poll of Linear, throttled to `poll_interval_min`.
 *
 * Called at the top of every dispatcher tick the way refreshLimits is, and a
 * no-op inside its own window — the 30s tick is collie's heartbeat, not a rate
 * anyone else's API agreed to. `force` is what the manual command passes.
 */
export async function syncLinear(
  cfg: Config,
  opts?: { force?: boolean; dryRun?: boolean; now?: number },
): Promise<SyncResult> {
  const now = opts?.now ?? Date.now();
  const linear = cfg.linear;
  if (!linear.enabled) return idle("disabled");

  const state = readLinearState();
  const dueIn = (state.lastSyncAt ?? 0) + linear.pollIntervalMin * 60_000 - now;
  if (!opts?.force && dueIn > 0) return idle(`next poll in ${Math.ceil(dueIn / 1000)}s`);

  const key = readApiKey();
  if (!key) return idle("no API key in the keychain (see `collie linear status`)");

  let issues: LinearIssue[];
  try {
    issues = await fetchLabeledIssues(key, linear.label);
  } catch (err) {
    // A reachability problem is not a reason to re-hammer on the next 30s
    // tick, so the clock advances even when the call failed.
    if (!opts?.dryRun) writeLinearState({ ...state, lastSyncAt: now });
    throw err instanceof LinearError ? err : new LinearError(String(err));
  }

  // The ledger plus what the working set already carries: a task made from an
  // issue is proof of import even if the ledger was lost since.
  const seen = new Set(Object.keys(state.imported));
  for (const t of listTasks()) {
    if (t.origin?.kind === "linear") seen.add(t.origin.id);
  }

  // The checkouts collie already knows about, from the same roots the new-task
  // picker uses: a Linear project named like its repo needs no mapping at all.
  let known: string[] = [];
  try {
    known = discoverRepos(cfg.repos.roots);
  } catch {
    // unreadable roots only cost the name-matching rung; [linear.repos] still works
  }

  const entries = planImport(issues, linear, seen, known, repoProblem);
  const created: string[] = [];
  const warnings: string[] = [];

  for (const entry of entries) {
    if (entry.action !== "import") continue;
    if (opts?.dryRun) continue;
    const { issue } = entry;
    let taskId: string;
    try {
      const task = createTask(
        {
          title: entry.title,
          repo: entry.repo,
          prompt: entry.prompt,
          priority: entry.priority,
          size: entry.size,
          origin: { kind: "linear", id: issue.id, ref: issue.identifier, url: issue.url },
        },
        { source: "linear" },
      );
      taskId = task.id;
    } catch (err) {
      warnings.push(`${issue.identifier}: could not create task (${(err as Error).message})`);
      continue;
    }
    created.push(taskId);
    // The ledger is written per task rather than once at the end: it is the
    // only thing standing between a crash here and a duplicate import, and
    // (now that Linear is told nothing until the task actually starts) it is
    // also the only guard covering the queued window, together with the
    // origin scan above.
    state.imported[issue.id] = { taskId, ref: issue.identifier, at: new Date(now).toISOString() };
    writeLinearState({ ...state, lastSyncAt: now });
  }

  if (!opts?.dryRun) writeLinearState({ ...state, lastSyncAt: now });
  return { entries, created, warnings };
}
