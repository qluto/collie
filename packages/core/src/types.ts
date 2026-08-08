export type TaskStatus =
  | "backlog"
  | "queued"
  | "running"
  | "blocked"
  | "review"
  | "done"
  | "failed";

export type TaskSize = "S" | "M" | "L";

export type ScheduleMode = "full" | "conservative" | "paused";

export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";

export interface TaskRun {
  paneId?: string;
  tabId?: string;
  workspaceId?: string;
  worktreePath?: string;
  sessionId?: string;
  lastHeartbeatAt?: string;
  idleSince?: string;
  resultSummary?: string;
  failureReason?: string;
  reportSeq?: number;
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  repo: string;
  priority: number;
  size: TaskSize;
  worktree: boolean;
  branch?: string;
  permissionMode: PermissionMode;
  claudeArgs: string[];
  createdAt: string;
  updatedAt: string;
  queuedAt?: string;
  startedAt?: string;
  endedAt?: string;
  attempts: number;
  maxAttempts: number;
  rev: number;
  run?: TaskRun;
  /** Markdown body of the task file — the prompt, verbatim. */
  prompt: string;
}

export interface NewTaskInput {
  title: string;
  repo: string;
  prompt: string;
  priority?: number;
  size?: TaskSize;
  worktree?: boolean;
  permissionMode?: PermissionMode;
  claudeArgs?: string[];
  maxAttempts?: number;
  status?: "backlog" | "queued";
}

export interface ScheduleWindow {
  /** "HH:MM" local time, inclusive start */
  start: string;
  /** "HH:MM" local time, exclusive end; may be earlier than start (crosses midnight) */
  end: string;
  mode: ScheduleMode;
}

export interface Config {
  dispatch: {
    wipLimit: number;
    pollIntervalSec: number;
    maxAttempts: number;
    idleGraceMin: number;
    readyTimeoutSec: number;
  };
  schedule: {
    windows: ScheduleWindow[];
    defaultMode: ScheduleMode;
  };
  quota: {
    blockBudgetTokens: number;
    weekBudgetTokens: number;
    fractionFull: number;
    fractionConservative: number;
    sizeEstimateTokens: Record<TaskSize, number>;
    conservativeMaxSize: TaskSize;
  };
  herdr: {
    socketPath: string;
  };
  defaults: {
    permissionMode: PermissionMode;
    worktree: boolean;
    worktreeRoot: string;
  };
}

export interface JournalEvent {
  ts: string;
  taskId: string;
  from: TaskStatus | null;
  to: TaskStatus;
  source: string;
  detail?: Record<string, unknown>;
}

export interface QuotaState {
  blockedUntil?: string;
  lastLimitKind?: "session" | "weekly" | "opus";
  learnedBlockCeiling?: number;
}

export interface DispatcherState {
  pid: number;
  startedAt: string;
  lastTickAt: string;
  mode: ScheduleMode | "degraded";
  wip: number;
  lastDecision: string;
}
