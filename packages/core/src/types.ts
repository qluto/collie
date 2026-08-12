export type TaskStatus =
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
  /**
   * Commit the task's branch started from. What makes "the branch is contained
   * in HEAD" mean "the work landed" instead of "the branch never moved".
   */
  baseCommit?: string;
  sessionId?: string;
  lastHeartbeatAt?: string;
  idleSince?: string;
  resultSummary?: string;
  failureReason?: string;
  reportSeq?: number;
  /** Notification-hook message: why the session stopped and waited for a human. */
  question?: string;
  /** Set once the dispatcher has captured the pane text behind that question. */
  questionScrapedAt?: string;
}

/**
 * Where a task came from when it was not a human at the capture form.
 *
 * Recorded on the task itself so the provenance outlives the import run and
 * follows the file into the archive; the importer's own index is a cache in
 * front of this, not a second truth.
 */
export interface TaskOrigin {
  kind: "linear";
  /** stable id in the source system — what dedup keys on */
  id: string;
  /** what a human would call it, e.g. "ENG-42" */
  ref: string;
  url?: string;
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
  origin?: TaskOrigin;
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
  origin?: TaskOrigin;
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
    /** blocked-on-question tasks tolerated before dispatch pauses */
    askingLimit: number;
    pollIntervalSec: number;
    maxAttempts: number;
    idleGraceMin: number;
    readyTimeoutSec: number;
  };
  schedule: {
    windows: ScheduleWindow[];
    defaultMode: ScheduleMode;
  };
  presence: {
    /**
     * Off by default: turning a daytime machine into a dispatch target has to
     * be a decision, not something a config-template update does to you.
     */
    enabled: boolean;
    /** input idle below this = a human is here */
    idleThresholdMin: number;
    /** ceiling on the schedule's mode while someone is present (any window) */
    whenPresent: "conservative" | "paused";
    /** count a working non-collie agent as presence */
    respectOtherAgents: boolean;
    /** opt-in: a long-idle machine may run full outside its full windows */
    absentUpgrade: boolean;
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
    /**
     * Use-it-or-lose-it: session headroom left unspent when the 5h limit resets
     * is simply gone, so close to a reset a full window may spend up to
     * `fraction` instead of fractionFull. Full mode only — the weekly cap is not
     * use-it-or-lose-it at session granularity and stays untouched.
     */
    burnDown: {
      enabled: boolean;
      /** minutes before the session reset in which the relaxed cap applies */
      windowMin: number;
      /** relaxed session cap, 0-1; only ever raises (max with fractionFull) */
      fraction: number;
    };
  };
  forecast: {
    /**
     * Rough % of a 5h session one M-size task costs. Purely presentational —
     * it turns the remaining headroom into "≈N tasks" in the TUI header and
     * has no gating power.
     */
    sessionPctPerTask: number;
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
  linear: {
    /**
     * Off by default: collie must never start reaching out to a third-party
     * API because a config template grew a section.
     */
    enabled: boolean;
    /** issue label that marks an issue as collie's to run */
    label: string;
    /**
     * Someone else's API, and issues do not appear by the second: this is
     * polled in minutes, not on the 30s dispatch tick.
     */
    pollIntervalMin: number;
    /**
     * Explicit name -> repo path. A key may be a project name or a team key;
     * projects are consulted first. Only needed when the Linear name and the
     * checkout's directory name disagree — see resolveRepo.
     */
    repos: Record<string, string>;
    /** issue-label prefix that names a repo per issue ("repo:"); "" disables */
    repoLabelPrefix: string;
    /** size every imported task gets; Linear estimates are workspace-specific */
    size: TaskSize;
    /** workflow state to move an imported issue into; "" = the team's first started one */
    startState: string;
    /** comment the collie task id back onto the issue */
    comment: boolean;
  };
}

export interface JournalEvent {
  ts: string;
  taskId: string;
  from: TaskStatus | null;
  /** "deleted" is not a status: it is the last thing a task file ever records. */
  to: TaskStatus | "deleted";
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
