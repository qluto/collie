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

/**
 * Mirrors `claude --permission-mode` (2.1.226 choices). `auto` is claude's own
 * default: a classifier runs the tool calls it judges low-risk and blocks the
 * rest — the right fit for unattended dispatch. `default` is not in the CLI's
 * advertised choices anymore (it was renamed `manual`) but is still accepted,
 * so task files written before the rename keep working.
 */
export type PermissionMode =
  | "auto"
  | "acceptEdits"
  | "plan"
  | "manual"
  | "dontAsk"
  | "bypassPermissions"
  | "default";

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
  /**
   * "Not urgent — only dispatch in a full schedule window." Orthogonal to
   * size (token cost) and priority (queue order): this one gates eligibility.
   */
  defer: boolean;
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
  defer?: boolean;
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
    /** cap on the weekly limit, shared by the real-percentage and token paths */
    weekFraction: number;
    sizeEstimateTokens: Record<TaskSize, number>;
    conservativeMaxSize: TaskSize;
  };
  herdr: {
    socketPath: string;
  };
  repos: {
    /** Parent directories scanned (2 levels deep) for git repos in the new-task picker. */
    roots: string[];
  };
  defaults: {
    permissionMode: PermissionMode;
    worktree: boolean;
    worktreeRoot: string;
  };
  done: {
    /** tear the task's pane/worktree down as part of `collie done` */
    close: boolean;
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
