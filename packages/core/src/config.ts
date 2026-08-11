import * as fs from "node:fs";
import { parse as parseToml } from "smol-toml";
import { configPath, ensureDataDirs, expandTilde } from "./paths.ts";
import type { Config, PermissionMode, ScheduleMode, ScheduleWindow, TaskSize } from "./types.ts";

export const DEFAULT_CONFIG_TOML = `[dispatch]
wip_limit = 2
asking_limit = 3             # blocked-on-question panes allowed to pile up before dispatch pauses
poll_interval_sec = 30
max_attempts = 2
idle_grace_min = 10          # running+idle this long without completion -> review
ready_timeout_sec = 60       # agent.start -> prompt-injectable deadline

[[schedule.windows]]
start = "00:00"
end = "07:00"
mode = "full"

[schedule]
default_mode = "conservative"   # applies outside all windows

[presence]
# macOS input-idle as a dispatch signal. Post-processes the schedule mode:
# a human at the keyboard downgrades full -> when_present; absent_upgrade
# lets a long-idle machine run full outside its windows. paused never
# upgrades. Off by default: turning your daytime machine into a dispatch
# target should be a decision, not an update.
enabled = false
idle_threshold_min = 20
when_present = "conservative"     # conservative|paused
respect_other_agents = true       # a working non-collie agent counts as "present"
absent_upgrade = false

[quota]
# Calibrate: when a real limit hit occurs, note ccusage's active-block totalTokens
# and set block_budget_tokens slightly below it. Start conservative.
block_budget_tokens = 60000000
week_budget_tokens = 800000000
fraction_full = 0.85          # of the 5h session limit
fraction_conservative = 0.35
week_fraction = 0.9           # of the 7-day limit, both modes
conservative_max_size = "M"

[quota.size_estimate_tokens]
S = 2000000
M = 8000000
L = 20000000

[quota.burn_down]
# use-it-or-lose-it: this close to the session reset, a full window may
# spend up to \`fraction\` instead of fraction_full — unspent session budget
# evaporates at reset anyway.
enabled = true
window_min = 90
fraction = 0.95

[forecast]
# Rough % of a 5h session one M-size task costs. The "≈N tasks" in the TUI
# header divides the remaining headroom by this — edit to taste. Display only:
# it never gates a dispatch.
session_pct_per_task = 15

[herdr]
socket_path = "~/.config/herdr/herdr.sock"

[done]
# true = "collie done" also tears the task down: worktree tasks go through
# worktree.remove (checkout deleted, pane + workspace closed, BRANCH KEPT),
# others just get their pane closed. Refused on an uncommitted worktree.
# "collie done --close" does this for one task regardless of the setting.
close = false

[repos]
# Parent directories scanned (2 levels deep) for the new-task repo picker.
# Works for flat layouts (~/dev/projects) and ghq host roots (~/ghq/github.com).
roots = []

[defaults]
# auto|acceptEdits|plan|manual|dontAsk|bypassPermissions (claude --permission-mode).
# auto = classifier runs low-risk tool calls, blocks the rest; unattended-safe.
# bypassPermissions shows a confirmation dialog on startup that the dispatcher
# does NOT auto-confirm — a task using it will wedge until a human clicks it.
permission_mode = "auto"
worktree = true
worktree_root = "~/dev/worktrees"
`;

export const DEFAULT_CONFIG: Config = {
  dispatch: {
    wipLimit: 2,
    askingLimit: 3,
    pollIntervalSec: 30,
    maxAttempts: 2,
    idleGraceMin: 10,
    readyTimeoutSec: 60,
  },
  schedule: {
    windows: [{ start: "00:00", end: "07:00", mode: "full" }],
    defaultMode: "conservative",
  },
  presence: {
    enabled: false,
    idleThresholdMin: 20,
    whenPresent: "conservative",
    respectOtherAgents: true,
    absentUpgrade: false,
  },
  quota: {
    blockBudgetTokens: 60_000_000,
    weekBudgetTokens: 800_000_000,
    fractionFull: 0.85,
    fractionConservative: 0.35,
    weekFraction: 0.9,
    sizeEstimateTokens: { S: 2_000_000, M: 8_000_000, L: 20_000_000 },
    conservativeMaxSize: "M",
    burnDown: { enabled: true, windowMin: 90, fraction: 0.95 },
  },
  forecast: {
    sessionPctPerTask: 15,
  },
  herdr: {
    socketPath: expandTilde("~/.config/herdr/herdr.sock"),
  },
  repos: {
    roots: [],
  },
  defaults: {
    permissionMode: "auto",
    worktree: true,
    worktreeRoot: expandTilde("~/dev/worktrees"),
  },
  done: {
    close: false,
  },
};

export class ConfigError extends Error {}

const MODES: ScheduleMode[] = ["full", "conservative", "paused"];
/** Presence only ever downgrades a full window — "full" here would be a no-op. */
const WHEN_PRESENT = ["conservative", "paused"] as const;
const SIZES: TaskSize[] = ["S", "M", "L"];
/** Mirrors `claude --permission-mode`, plus the legacy `default` alias. */
export const PERMISSION_MODES: PermissionMode[] = [
  "auto", "acceptEdits", "plan", "manual", "dontAsk", "bypassPermissions", "default",
];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function fail(msg: string): never {
  throw new ConfigError(`config.toml: ${msg}`);
}

function num(v: unknown, name: string, opts?: { min?: number; max?: number }): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${name} must be a number`);
  if (opts?.min !== undefined && v < opts.min) fail(`${name} must be >= ${opts.min}`);
  if (opts?.max !== undefined && v > opts.max) fail(`${name} must be <= ${opts.max}`);
  return v;
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) fail(`${name} must be a non-empty string`);
  return v;
}

function bool(v: unknown, name: string): boolean {
  if (typeof v !== "boolean") fail(`${name} must be a boolean`);
  return v;
}

function oneOf<T extends string>(v: unknown, name: string, allowed: readonly T[]): T {
  const s = str(v, name);
  if (!allowed.includes(s as T)) fail(`${name} must be one of ${allowed.join("|")}`);
  return s as T;
}

// deep get with dotted path against the raw TOML object
function get(raw: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = raw;
  for (const key of dotted.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Parse + validate a TOML string into Config. Missing keys fall back to defaults. */
export function parseConfig(toml: string): Config {
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(toml) as Record<string, unknown>;
  } catch (err) {
    fail(`TOML parse error: ${(err as Error).message}`);
  }

  const d = DEFAULT_CONFIG;
  const pick = <T>(dotted: string, fallback: T, check: (v: unknown) => T): T => {
    const v = get(raw, dotted);
    return v === undefined ? fallback : check(v);
  };

  const windowsRaw = get(raw, "schedule.windows");
  let windows: ScheduleWindow[] = d.schedule.windows;
  if (windowsRaw !== undefined) {
    if (!Array.isArray(windowsRaw)) fail("schedule.windows must be an array of tables");
    windows = windowsRaw.map((w, i) => {
      const o = w as Record<string, unknown>;
      const start = str(o.start, `schedule.windows[${i}].start`);
      const end = str(o.end, `schedule.windows[${i}].end`);
      if (!HHMM.test(start) || !HHMM.test(end)) {
        fail(`schedule.windows[${i}] start/end must be "HH:MM"`);
      }
      return { start, end, mode: oneOf(o.mode, `schedule.windows[${i}].mode`, MODES) };
    });
  }

  return {
    dispatch: {
      wipLimit: pick("dispatch.wip_limit", d.dispatch.wipLimit, (v) => num(v, "dispatch.wip_limit", { min: 1, max: 16 })),
      askingLimit: pick("dispatch.asking_limit", d.dispatch.askingLimit, (v) => num(v, "dispatch.asking_limit", { min: 1, max: 16 })),
      pollIntervalSec: pick("dispatch.poll_interval_sec", d.dispatch.pollIntervalSec, (v) => num(v, "dispatch.poll_interval_sec", { min: 5 })),
      maxAttempts: pick("dispatch.max_attempts", d.dispatch.maxAttempts, (v) => num(v, "dispatch.max_attempts", { min: 1, max: 10 })),
      idleGraceMin: pick("dispatch.idle_grace_min", d.dispatch.idleGraceMin, (v) => num(v, "dispatch.idle_grace_min", { min: 1 })),
      readyTimeoutSec: pick("dispatch.ready_timeout_sec", d.dispatch.readyTimeoutSec, (v) => num(v, "dispatch.ready_timeout_sec", { min: 10 })),
    },
    schedule: {
      windows,
      defaultMode: pick("schedule.default_mode", d.schedule.defaultMode, (v) => oneOf(v, "schedule.default_mode", MODES)),
    },
    presence: {
      enabled: pick("presence.enabled", d.presence.enabled, (v) => bool(v, "presence.enabled")),
      // 480 = 8h: past that the "is anyone here" question is really "is this
      // machine asleep", which the probe cannot answer either way.
      idleThresholdMin: pick("presence.idle_threshold_min", d.presence.idleThresholdMin, (v) => num(v, "presence.idle_threshold_min", { min: 1, max: 480 })),
      whenPresent: pick("presence.when_present", d.presence.whenPresent, (v) => oneOf(v, "presence.when_present", WHEN_PRESENT)),
      respectOtherAgents: pick("presence.respect_other_agents", d.presence.respectOtherAgents, (v) => bool(v, "presence.respect_other_agents")),
      absentUpgrade: pick("presence.absent_upgrade", d.presence.absentUpgrade, (v) => bool(v, "presence.absent_upgrade")),
    },
    quota: {
      blockBudgetTokens: pick("quota.block_budget_tokens", d.quota.blockBudgetTokens, (v) => num(v, "quota.block_budget_tokens", { min: 1 })),
      weekBudgetTokens: pick("quota.week_budget_tokens", d.quota.weekBudgetTokens, (v) => num(v, "quota.week_budget_tokens", { min: 1 })),
      fractionFull: pick("quota.fraction_full", d.quota.fractionFull, (v) => num(v, "quota.fraction_full", { min: 0, max: 1 })),
      fractionConservative: pick("quota.fraction_conservative", d.quota.fractionConservative, (v) => num(v, "quota.fraction_conservative", { min: 0, max: 1 })),
      weekFraction: pick("quota.week_fraction", d.quota.weekFraction, (v) => num(v, "quota.week_fraction", { min: 0, max: 1 })),
      sizeEstimateTokens: {
        S: pick("quota.size_estimate_tokens.S", d.quota.sizeEstimateTokens.S, (v) => num(v, "quota.size_estimate_tokens.S", { min: 0 })),
        M: pick("quota.size_estimate_tokens.M", d.quota.sizeEstimateTokens.M, (v) => num(v, "quota.size_estimate_tokens.M", { min: 0 })),
        L: pick("quota.size_estimate_tokens.L", d.quota.sizeEstimateTokens.L, (v) => num(v, "quota.size_estimate_tokens.L", { min: 0 })),
      },
      conservativeMaxSize: pick("quota.conservative_max_size", d.quota.conservativeMaxSize, (v) => oneOf(v, "quota.conservative_max_size", SIZES)),
      burnDown: {
        enabled: pick("quota.burn_down.enabled", d.quota.burnDown.enabled, (v) => {
          if (typeof v !== "boolean") fail("quota.burn_down.enabled must be a boolean");
          return v;
        }),
        // capped at 300: past five hours the "window" spans a whole session and
        // the relaxed cap would just be the cap.
        windowMin: pick("quota.burn_down.window_min", d.quota.burnDown.windowMin, (v) => num(v, "quota.burn_down.window_min", { min: 1, max: 300 })),
        fraction: pick("quota.burn_down.fraction", d.quota.burnDown.fraction, (v) => num(v, "quota.burn_down.fraction", { min: 0, max: 1 })),
      },
    },
    forecast: {
      sessionPctPerTask: pick("forecast.session_pct_per_task", d.forecast.sessionPctPerTask, (v) => num(v, "forecast.session_pct_per_task", { min: 1, max: 100 })),
    },
    herdr: {
      socketPath: expandTilde(pick("herdr.socket_path", d.herdr.socketPath, (v) => str(v, "herdr.socket_path"))),
    },
    repos: {
      roots: pick("repos.roots", d.repos.roots, (v) => {
        if (!Array.isArray(v)) fail("repos.roots must be an array of strings");
        return v.map((r, i) => expandTilde(str(r, `repos.roots[${i}]`)));
      }),
    },
    defaults: {
      permissionMode: pick("defaults.permission_mode", d.defaults.permissionMode, (v) => oneOf(v, "defaults.permission_mode", PERMISSION_MODES)),
      worktree: pick("defaults.worktree", d.defaults.worktree, (v) => {
        if (typeof v !== "boolean") fail("defaults.worktree must be a boolean");
        return v;
      }),
      worktreeRoot: expandTilde(pick("defaults.worktree_root", d.defaults.worktreeRoot, (v) => str(v, "defaults.worktree_root"))),
    },
    done: {
      close: pick("done.close", d.done.close, (v) => {
        if (typeof v !== "boolean") fail("done.close must be a boolean");
        return v;
      }),
    },
  };
}

/**
 * Load config from ~/.collie/config.toml. Writes the default template on
 * first run so the user has something to edit. Throws ConfigError when invalid.
 *
 * Only a MISSING file is bootstrapped, and only ever with "wx": an existing
 * config is the user's, and the template must never land on top of it. That
 * also means a config written before a feature existed never grows its section
 * — every key falls back to DEFAULT_CONFIG instead (see `pick`).
 */
export function loadConfig(): Config {
  const p = configPath();
  let toml: string;
  try {
    toml = fs.readFileSync(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // First run: $COLLIE_HOME itself may not exist yet, so the template write
    // has to create the tree before it can land.
    ensureDataDirs();
    try {
      fs.writeFileSync(p, DEFAULT_CONFIG_TOML, { flag: "wx" });
    } catch (raced) {
      if ((raced as NodeJS.ErrnoException).code !== "EEXIST") throw raced;
    }
    toml = fs.readFileSync(p, "utf8");
  }
  return parseConfig(toml);
}
