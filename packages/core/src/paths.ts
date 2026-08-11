import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

/** Root data dir. Overridable for tests via COLLIE_HOME (empty string = unset). */
export function hubHome(): string {
  const env = process.env.COLLIE_HOME;
  return env && env.length > 0 ? env : path.join(os.homedir(), ".collie");
}

export function tasksDir(): string {
  return path.join(hubHome(), "tasks");
}

export function runsDir(taskId?: string): string {
  const base = path.join(hubHome(), "runs");
  return taskId ? path.join(base, taskId) : base;
}

export function logsDir(): string {
  return path.join(hubHome(), "logs");
}

export function configPath(): string {
  return path.join(hubHome(), "config.toml");
}

export function journalPath(): string {
  return path.join(hubHome(), "events.jsonl");
}

export function quotaStatePath(): string {
  return path.join(hubHome(), "quota.json");
}

export function dispatcherStatePath(): string {
  return path.join(hubHome(), "dispatcher.json");
}

/** Cached copy of Anthropic's own limit percentages (see quota/limits-api.ts). */
export function limitsStatePath(): string {
  return path.join(hubHome(), "limits.json");
}

/** Cached answer to "did each task's branch land?" (see branches.ts). */
export function branchScanPath(): string {
  return path.join(hubHome(), "branches.json");
}

export function lockPath(): string {
  return path.join(hubHome(), "lock");
}

/** Finished tasks move here so the working set stays what still needs a human. */
export function archiveDir(): string {
  return path.join(tasksDir(), "archive");
}

export function taskFilePath(id: string): string {
  return path.join(tasksDir(), `${id}.md`);
}

export function archivedTaskFilePath(id: string): string {
  return path.join(archiveDir(), `${id}.md`);
}

/** Expand a leading ~ to the user's home directory. */
export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Create the runtime directory tree if missing. Safe to call repeatedly. */
export function ensureDataDirs(): void {
  for (const dir of [hubHome(), tasksDir(), archiveDir(), runsDir(), logsDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
