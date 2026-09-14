import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as YAML from "yaml";
import { archiveDir, archivedTaskFilePath, expandTilde, taskFilePath, tasksDir, ensureDataDirs } from "./paths.ts";
import { repoProblem } from "./repos.ts";
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
  queued: ["running", "failed"], // queued→failed: spawn attempts exhausted
  running: ["blocked", "review", "failed", "queued"],
  blocked: ["running", "review", "failed", "queued"], // blocked→queued: pane died while blocked
  review: ["done", "queued"],
  // done→review is the undo for a task closed too fast (the task list's `u`): it
  // walks back out of the archive into the working set.
  done: ["review"],
  failed: ["queued"],
};

// --- (de)serialization ------------------------------------------------------

const FRONTMATTER_KEYS: Array<keyof Task> = [
  "id", "title", "status", "repo", "priority", "size", "model", "worktree", "branch",
  "permissionMode", "claudeArgs", "createdAt", "updatedAt", "queuedAt",
  "startedAt", "endedAt", "attempts", "maxAttempts", "rev", "run", "origin", "startNow",
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
  const { defer: _legacyDefer, ...t } = fm as unknown as Task & { defer?: boolean };
  if (typeof t.id !== "string" || typeof t.status !== "string") {
    throw new StoreError(`${sourcePath}: frontmatter missing id/status`);
  }
  // Lazy migration: files captured before the refocus can still say "backlog",
  // which no longer exists — tossing a task in has always meant "run it".
  if ((t.status as string) === "backlog") t.status = "queued";
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

/** Live file first, then the archive — a done task is still readable by id. */
function readTask(id: string): Task | null {
  for (const p of [taskFilePath(id), archivedTaskFilePath(id)]) {
    try {
      return parseTaskFile(fs.readFileSync(p, "utf8"), p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return null;
}

// --- public API -------------------------------------------------------------

export function generateId(now = new Date()): string {
  const ymd = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `t-${ymd}-${crypto.randomBytes(2).toString("hex")}`;
}

export function listTasks(filter?: { status?: TaskStatus[]; includeArchived?: boolean }): Task[] {
  ensureDataDirs();
  // keyed by id: a home mid-migration can hold both a live and an archived copy
  // of the same task, and the live one is the newer record
  const byId = new Map<string, Task>();
  const dirs = [tasksDir(), ...(filter?.includeArchived ? [archiveDir()] : [])];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue; // archive/ may not exist yet
    }
    for (const entry of entries) {
      // the archive subdirectory is skipped for free: it is not a *.md entry
      if (!entry.endsWith(".md") || entry.startsWith(".")) continue;
      const p = path.join(dir, entry);
      try {
        const task = parseTaskFile(fs.readFileSync(p, "utf8"), p);
        if (!byId.has(task.id)) byId.set(task.id, task);
      } catch {
        // unparseable file: skip rather than take the whole board down
      }
    }
  }
  const tasks = [...byId.values()];
  const filtered = filter?.status ? tasks.filter((t) => filter.status!.includes(t.status)) : tasks;
  return filtered.sort(
    (a, b) =>
      a.priority - b.priority ||
      (a.queuedAt ?? a.createdAt).localeCompare(b.queuedAt ?? b.createdAt) ||
      a.id.localeCompare(b.id), // stable final tie-breaker
  );
}

/**
 * The archive, newest first — "what did I even do last night". The archive only
 * ever grows, so selection is one stat per file and ONLY `limit` files are
 * parsed; `limit: 0` degenerates to a single readdir, which is what the TUI
 * costs while the section is folded.
 */
export function listArchived(limit: number): { tasks: Task[]; total: number } {
  ensureDataDirs();
  let entries: string[];
  try {
    entries = fs.readdirSync(archiveDir()).filter((e) => e.endsWith(".md") && !e.startsWith("."));
  } catch {
    return { tasks: [], total: 0 };
  }
  const newest = entries
    .map((entry) => {
      const p = path.join(archiveDir(), entry);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(p).mtimeMs;
      } catch {
        // raced with a rename; sorts last and is skipped if it stays gone
      }
      return { p, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(0, limit));

  const tasks: Task[] = [];
  for (const { p } of newest) {
    try {
      tasks.push(parseTaskFile(fs.readFileSync(p, "utf8"), p));
    } catch {
      // unparseable or vanished: skip rather than take the view down
    }
  }
  // mtime picks which files are new; what a human means by "recent" is endedAt
  tasks.sort((a, b) => (b.endedAt ?? b.updatedAt).localeCompare(a.endedAt ?? a.updatedAt));
  return { tasks, total: entries.length };
}

export function getTask(id: string): Task | null {
  ensureDataDirs();
  return readTask(id);
}

export function createTask(input: NewTaskInput, opts?: { source?: string }): Task {
  ensureDataDirs();

  // The one funnel every entry point goes through — CLI, TUI, popup, Linear
  // import — so the repo is checked once, here, and no path can reach the
  // queue that the dispatcher will only choke on at 2am. Stored absolute:
  // "~/x" and "./x" are the same repo as "/Users/me/x" to everything that
  // later groups tasks by it.
  // Emptiness is checked BEFORE resolving: path.resolve("") is the process's
  // cwd, so a blank repo would silently become "wherever collie happens to be
  // running", which for the dispatcher is nowhere near the user's intent.
  const raw = input.repo.trim();
  if (raw.length === 0) throw new StoreError("repo is empty");
  const repo = path.resolve(expandTilde(raw));
  const problem = repoProblem(repo);
  if (problem) throw new StoreError(`repo ${raw} ${problem}`);

  const now = new Date().toISOString();
  // user config supplies the defaults; fall back to built-ins if it's invalid
  let config = DEFAULT_CONFIG;
  try {
    config = loadConfig();
  } catch {
    // keep built-in defaults
  }
  const d = config.defaults;
  const task: Task = {
    id: generateId(),
    title: input.title,
    // tossed in = will run; there is no captured-but-not-queued state anymore
    status: "queued",
    repo,
    priority: input.priority ?? 100,
    size: input.size ?? "M",
    // "" is never stored: absent means claude's own default, and a key holding
    // an empty string would reach agent.start as `--model ""`.
    model: input.model?.trim() || d.model.trim() || undefined,
    worktree: input.worktree ?? d.worktree,
    permissionMode: input.permissionMode ?? d.permissionMode,
    claudeArgs: input.claudeArgs ?? [],
    createdAt: now,
    updatedAt: now,
    queuedAt: now,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? config.dispatch.maxAttempts,
    rev: 0,
    origin: input.origin,
    prompt: input.prompt,
  };
  if (task.worktree) task.branch = `collie/${task.id}`;
  return withLock(() => {
    if (readTask(task.id)) throw new StoreError(`task id collision: ${task.id}`);
    writeTaskFile(task);
    appendEvent({ ts: now, taskId: task.id, from: null, to: task.status, source: opts?.source ?? "cli" });
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
    // A done task leaves the working set: write the final content first, then
    // move it, so the archived file is the complete record either way.
    if (to === "done") fs.renameSync(taskFilePath(id), archivedTaskFilePath(id));
    // Coming back out, writeTaskFile has already put the live copy in place;
    // dropping the archived one last means a crash leaves a duplicate rather
    // than no task at all.
    if (from === "done") fs.rmSync(archivedTaskFilePath(id), { force: true });
    appendEvent({
      ts: now, taskId: id, from, to,
      source: opts?.source ?? "unknown",
      detail: patch ? { patch } : undefined,
    });
    return task;
  });
}

/**
 * Human-initiated re-run: back to queued with a fresh attempt budget. Without
 * the reset, retrying a task that already exhausted its attempts hands the
 * dispatcher zero retries — the first hiccup fails it again immediately.
 */
export function retryTask(id: string, opts?: { source?: string }): Task {
  transition(id, "queued", undefined, opts);
  return updateTask(id, (t) => {
    t.attempts = 0;
  });
}

/**
 * Human-in-the-loop completion, run from the agent's own pane. Idempotent so a
 * second keypress is a no-op rather than an error. running/blocked route
 * through review: the human looking at the session knows more than the
 * completion callback that never arrived.
 */
export function markDone(id: string, opts?: { source?: string }): Task {
  const task = getTask(id);
  if (!task) throw new StoreError(`no such task: ${id}`);
  if (task.status === "done") return task;
  if (task.status === "running" || task.status === "blocked") {
    transition(id, "review", undefined, opts);
  } else if (task.status !== "review") {
    throw new StoreError(`task ${id} is ${task.status}; only a running or review task can be marked done`);
  }
  return transition(id, "done", undefined, opts);
}

/**
 * Remove a task outright. Used for a mis-toss: parking it in `failed` would
 * pollute the one lane that means "something actually went wrong".
 */
export function deleteTask(id: string, opts?: { source?: string }): Task {
  ensureDataDirs();
  return withLock(() => {
    const task = readTask(id);
    if (!task) throw new StoreError(`no such task: ${id}`);
    fs.unlinkSync(fs.existsSync(taskFilePath(id)) ? taskFilePath(id) : archivedTaskFilePath(id));
    appendEvent({
      ts: new Date().toISOString(), taskId: id, from: task.status, to: "deleted",
      source: opts?.source ?? "unknown",
    });
    return task;
  });
}

/** Cancel: a queued task vanishes; anything already in flight is forced to failed. */
export function cancelTask(id: string, opts?: { source?: string }): Task {
  const task = getTask(id);
  if (!task) throw new StoreError(`no such task: ${id}`);
  if (task.status === "queued") return deleteTask(id, opts);
  if (task.status === "done" || task.status === "failed") return task;
  return transition(id, "failed", { failureReason: "cancelled" }, { ...opts, force: true });
}
