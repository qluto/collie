import * as fs from "node:fs";
import { ensureDataDirs, linearStatePath } from "../paths.ts";
import { createTask, listTasks } from "../store.ts";
import type { Config } from "../types.ts";
import {
  LinearError, commentOnIssue, fetchLabeledIssues, fetchWorkflowStates, moveIssueToState, readApiKey,
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
 * Move the issue out of the backlog and say where it went. Best-effort by
 * design: the task already exists locally, so a failure here must not undo it
 * or stop the next issue — it becomes a warning and the local ledger, which
 * has already recorded the import, is what keeps it from being imported twice.
 */
async function writeBack(
  key: string,
  cfg: Config["linear"],
  issue: LinearIssue,
  taskId: string,
  warnings: string[],
): Promise<void> {
  try {
    const states = await fetchWorkflowStates(key, issue.team.id);
    const target = pickStartState(states, cfg.startState);
    if (!target) {
      warnings.push(
        `${issue.identifier}: no ${cfg.startState || "started"} state on team ${issue.team.key}; left as is`,
      );
    } else if (target.id !== issue.state.id) {
      await moveIssueToState(key, issue.id, target.id);
    }
  } catch (err) {
    warnings.push(`${issue.identifier}: could not move state (${(err as Error).message})`);
  }
  if (!cfg.comment) return;
  try {
    await commentOnIssue(key, issue.id, `Picked up by collie as \`${taskId}\`.`);
  } catch (err) {
    warnings.push(`${issue.identifier}: could not comment (${(err as Error).message})`);
  }
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

  const entries = planImport(issues, linear, seen);
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
    // Ledger first, write-back second: the local record is what prevents a
    // duplicate, and it must survive a crash in the middle of the round trip.
    state.imported[issue.id] = { taskId, ref: issue.identifier, at: new Date(now).toISOString() };
    writeLinearState({ ...state, lastSyncAt: now });
    await writeBack(key, linear, issue, taskId, warnings);
  }

  if (!opts?.dryRun) writeLinearState({ ...state, lastSyncAt: now });
  return { entries, created, warnings };
}
