import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as YAML from "yaml";
import { taskFilePath, tasksDir, ensureDataDirs } from "./paths.ts";
import { withLock } from "./lock.ts";
import { appendEvent } from "./journal.ts";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import type { NewTaskInput, Task, TaskRun, TaskStatus } from "./types.ts";

export class StoreError extends Error {}
export class IllegalTransitionError extends StoreError {
  constructor(id: string, from: TaskStatus, to: TaskStatus) {
    super(`task ${id}: illegal transition ${from} -> ${to}`);
  }
}

const LEGAL_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ["queued"],
  queued: ["backlog", "running", "failed"], // queued→failed: spawn attempts exhausted
  running: ["blocked", "review", "failed", "queued"],
  blocked: ["running", "review", "failed", "queued"], // blocked→queued: pane died while blocked
  review: ["done", "queued"],
  done: [],
  failed: ["queued"],
};

// --- (de)serialization ------------------------------------------------------

const FRONTMATTER_KEYS: Array<keyof Task> = [
  "id", "title", "status", "repo", "priority", "size", "worktree", "branch",
  "permissionMode", "claudeArgs", "createdAt", "updatedAt", "queuedAt",
  "startedAt", "endedAt", "attempts", "maxAttempts", "rev", "run",
];

export function serializeTask(task: Task): string {
  const fm: Record<string, unknown> = {};
  for (const key of FRONTMATTER_KEYS) {
    const v = task[key];
    if (v !== undefined) fm[key] = v;
  }
  return `---\n${YAML.stringify(fm)}---\n${task.prompt}`;
}

export function parseTaskFile(content: string, sourcePath: string): Task {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  if (!m) throw new StoreError(`${sourcePath}: missing frontmatter`);
  const fm = YAML.parse(m[1]!) as Record<string, unknown>;
  const prompt = m[2] ?? "";
  const t = fm as unknown as Task;
  if (typeof t.id !== "string" || typeof t.status !== "string") {
    throw new StoreError(`${sourcePath}: frontmatter missing id/status`);
  }
  if (!(t.status in LEGAL_TRANSITIONS)) {
    throw new StoreError(`${sourcePath}: unknown status "${t.status}"`);
  }
  return { ...t, claudeArgs: t.claudeArgs ?? [], prompt };
}

/** Atomic write: temp file in the same directory + rename. */
function writeTaskFile(task: Task): void {
  const dest = taskFilePath(task.id);
  const tmp = path.join(tasksDir(), `.${task.id}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, serializeTask(task));
  fs.renameSync(tmp, dest);
}

function readTask(id: string): Task | null {
  try {
    return parseTaskFile(fs.readFileSync(taskFilePath(id), "utf8"), taskFilePath(id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// --- public API -------------------------------------------------------------

export function generateId(now = new Date()): string {
  const ymd = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `t-${ymd}-${crypto.randomBytes(2).toString("hex")}`;
}

export function listTasks(filter?: { status?: TaskStatus[] }): Task[] {
  ensureDataDirs();
  const tasks: Task[] = [];
  for (const entry of fs.readdirSync(tasksDir())) {
    if (!entry.endsWith(".md") || entry.startsWith(".")) continue;
    const p = path.join(tasksDir(), entry);
    try {
      tasks.push(parseTaskFile(fs.readFileSync(p, "utf8"), p));
    } catch {
      // unparseable file: skip rather than take the whole board down
    }
  }
  const filtered = filter?.status ? tasks.filter((t) => filter.status!.includes(t.status)) : tasks;
  return filtered.sort(
    (a, b) =>
      a.priority - b.priority ||
      (a.queuedAt ?? a.createdAt).localeCompare(b.queuedAt ?? b.createdAt) ||
      a.id.localeCompare(b.id), // stable final tie-breaker
  );
}

export function getTask(id: string): Task | null {
  ensureDataDirs();
  return readTask(id);
}

export function createTask(input: NewTaskInput, opts?: { source?: string }): Task {
  ensureDataDirs();
  const now = new Date().toISOString();
  // user config supplies the defaults; fall back to built-ins if it's invalid
  let config = DEFAULT_CONFIG;
  try {
    config = loadConfig();
  } catch {
    // keep built-in defaults
  }
  const d = config.defaults;
  const status = input.status ?? "backlog";
  const task: Task = {
    id: generateId(),
    title: input.title,
    status,
    repo: input.repo,
    priority: input.priority ?? 100,
    size: input.size ?? "M",
    worktree: input.worktree ?? d.worktree,
    permissionMode: input.permissionMode ?? d.permissionMode,
    claudeArgs: input.claudeArgs ?? [],
    createdAt: now,
    updatedAt: now,
    queuedAt: status === "queued" ? now : undefined,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? config.dispatch.maxAttempts,
    rev: 0,
    prompt: input.prompt,
  };
  if (task.worktree) task.branch = `agent-hub/${task.id}`;
  return withLock(() => {
    if (readTask(task.id)) throw new StoreError(`task id collision: ${task.id}`);
    writeTaskFile(task);
    appendEvent({ ts: now, taskId: task.id, from: null, to: status, source: opts?.source ?? "cli" });
    return task;
  });
}

/**
 * Read-modify-write under the global lock. `mutate` may change anything except
 * id/status (use transition for status). Bumps rev + updatedAt.
 */
export function updateTask(id: string, mutate: (t: Task) => void, _opts?: { source?: string }): Task {
  ensureDataDirs();
  return withLock(() => {
    const task = readTask(id);
    if (!task) throw new StoreError(`no such task: ${id}`);
    const before = { id: task.id, status: task.status };
    mutate(task);
    if (task.id !== before.id) throw new StoreError("updateTask must not change id");
    if (task.status !== before.status) throw new StoreError("updateTask must not change status; use transition()");
    task.rev += 1;
    task.updatedAt = new Date().toISOString();
    writeTaskFile(task);
    return task;
  });
}

export function transition(
  id: string,
  to: TaskStatus,
  patch?: Partial<TaskRun> & { failureReason?: string },
  opts?: { source?: string; force?: boolean },
): Task {
  ensureDataDirs();
  return withLock(() => {
    const task = readTask(id);
    if (!task) throw new StoreError(`no such task: ${id}`);
    const from = task.status;
    if (!opts?.force && !LEGAL_TRANSITIONS[from].includes(to)) {
      throw new IllegalTransitionError(id, from, to);
    }
    const now = new Date().toISOString();
    task.status = to;
    task.rev += 1;
    task.updatedAt = now;
    if (to === "queued") task.queuedAt = now;
    if (to === "running" && from === "queued") task.startedAt = now;
    if (to === "done" || to === "failed") task.endedAt = now;
    if (patch) {
      task.run = { ...task.run, ...patch };
      // explicit undefined in a patch clears the field (e.g. paneId on requeue)
      for (const key of Object.keys(task.run) as Array<keyof typeof task.run>) {
        if (task.run[key] === undefined) delete task.run[key];
      }
    }
    writeTaskFile(task);
    appendEvent({
      ts: now, taskId: id, from, to,
      source: opts?.source ?? "unknown",
      detail: patch ? { patch } : undefined,
    });
    return task;
  });
}

/** Cancel: any non-terminal status -> failed (queued/backlog cancel is a plain delete-from-queue). */
export function cancelTask(id: string, opts?: { source?: string }): Task {
  const task = getTask(id);
  if (!task) throw new StoreError(`no such task: ${id}`);
  if (task.status === "queued") return transition(id, "backlog", undefined, opts);
  if (task.status === "done" || task.status === "failed" || task.status === "backlog") return task;
  return transition(id, "failed", { failureReason: "cancelled" }, { ...opts, force: true });
}
