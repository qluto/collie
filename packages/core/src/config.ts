import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { configPath, ensureDataDirs, expandTilde } from "./paths.ts";
import type { Config, PermissionMode, ScheduleMode, ScheduleWindow, TaskSize, WorktreeSettings } from "./types.ts";

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
# while a human is here the mode is capped at when_present — a ceiling on
# EVERY window, not just full ones — and absent_upgrade lets a long-idle
# machine run full outside its windows. paused never upgrades. Off by
# default: turning your daytime machine into a dispatch target should be a
# decision, not an update.
enabled = false
idle_threshold_min = 20
when_present = "paused"           # conservative|paused; paused = no new work while you are here
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
# Model every task runs on unless it names its own: "" = claude's default.
# Any name claude --model accepts (sonnet, opus, fable, a full model id).
model = ""
# What the new-task form offers, after "(default)".
model_choices = ["sonnet", "opus", "fable"]
worktree = true
worktree_root = "~/dev/worktrees"

[worktree]
# Branch a task's worktree forks from. "" = the remote's default branch (what
# origin/HEAD points at — main for most repos). Set it where the team branches
# from somewhere else:  base = "develop"
base = ""
# Fetch that branch from origin right before forking, so a local develop that
# is a week old is never what the night's work starts from. A failed fetch
# (offline, no remote) falls back to what is local and says so in the log.
fetch = true
# Shell snippet run INSIDE the fresh checkout, before the agent starts — for
# the files git does not carry (.env, local settings). /bin/sh -c, with
# COLLIE_REPO (main checkout), COLLIE_WORKTREE, COLLIE_BRANCH, COLLIE_TASK_ID:
#   post_create = 'cp "$COLLIE_REPO/.env" .env'
#   post_create = "~/dev/projects/myapp/.collie/worktree-setup.sh"
# A non-zero exit fails that dispatch attempt (the task is requeued and the
# same checkout reopened), so keep it idempotent. Output lands in
# runs/<id>/post_create.log.
post_create = ""
post_create_timeout_sec = 60

# Per-repo overrides, keyed by the checkout's path (~ is fine):
# [worktree.repos."~/dev/projects/myapp"]
# base = "develop"
# post_create = 'ln -sf "$COLLIE_REPO/.env" .env'

[linear]
# Auto-collect Linear issues carrying \`label\` as collie tasks. Off by default.
# An issue whose repo cannot be worked out is skipped with the reason printed,
# never guessed at — see [linear.repos] below for how that is decided.
#
# The API key is NOT read from this file (the TUI shows this file in full):
#   security add-generic-password -s "collie-linear" -a "$USER" -w "lin_api_..."
enabled = false
label = "collie"
poll_interval_min = 5        # someone else's API: minutes, not the 30s tick
assignee = "me"              # me|any — "me" keeps two people on one team apart
size = "M"                   # imported tasks all get this size
start_state = ""             # move the issue here on import; "" = the team's first started state
comment = true               # comment the collie task id back onto the issue
# Per-issue repo override, two spellings — a Linear label GROUP named "repo"
# whose child is the repo name (the native way), or a flat "repo:collie"
# label. Either may be "" to switch it off.
repo_label_group = "repo"
repo_label_prefix = "repo:"

[linear.repos]
# WHICH REPO an issue is about is answered most-specific-first:
#   1. a "repo:<name>" label on the issue
#   2. the issue's project name
#   3. its team key
# At each step the name is looked up here first, then matched against the
# checkouts under [repos] roots by directory name — so a Linear project called
# "myapp" next to ~/dev/projects/myapp needs no entry at all. Add one only when
# the two names disagree:
# "Mobile app" = "~/dev/projects/myapp"
# "ENG"        = "~/dev/projects/monorepo"
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
    whenPresent: "paused",
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
    model: "",
    modelChoices: ["sonnet", "opus", "fable"],
    worktree: true,
    worktreeRoot: expandTilde("~/dev/worktrees"),
  },
  done: {
    close: false,
  },
  worktree: {
    base: "",
    fetch: true,
    postCreate: "",
    postCreateTimeoutSec: 60,
    repos: {},
  },
  linear: {
    enabled: false,
    label: "collie",
    pollIntervalMin: 5,
    repos: {},
    assignee: "me",
    repoLabelGroup: "repo",
    repoLabelPrefix: "repo:",
    size: "M",
    startState: "",
    comment: true,
  },
};

export class ConfigError extends Error {}

const MODES: ScheduleMode[] = ["full", "conservative", "paused"];
/** Presence only ever caps the mode — "full" here would be a no-op ceiling. */
const WHEN_PRESENT = ["conservative", "paused"] as const;
const SIZES: TaskSize[] = ["S", "M", "L"];
/** Sharing a team means sharing a label, so "mine" has to be the default. */
const ASSIGNEES = ["me", "any"] as const;
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

/** Like str(), but "" is a meaningful value: "no base", "no script". */
function optStr(v: unknown, name: string): string {
  if (typeof v !== "string") fail(`${name} must be a string`);
  return v;
}

/** 1s floor (0 could never finish), 1h ceiling (dispatch would look wedged). */
function timeoutSec(v: unknown, name: string): number {
  return num(v, name, { min: 1, max: 3600 });
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
      // "" is meaningful here: it means "pass no --model at all"
      model: pick("defaults.model", d.defaults.model, (v) => optStr(v, "defaults.model")),
      modelChoices: pick("defaults.model_choices", d.defaults.modelChoices, (v) => {
        if (!Array.isArray(v)) fail("defaults.model_choices must be an array of strings");
        return v.map((m, i) => {
          const name = str(m, `defaults.model_choices[${i}]`).trim();
          if (name.length === 0) fail(`defaults.model_choices[${i}] must not be empty`);
          return name;
        });
      }),
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
    worktree: {
      base: pick("worktree.base", d.worktree.base, (v) => optStr(v, "worktree.base")),
      fetch: pick("worktree.fetch", d.worktree.fetch, (v) => bool(v, "worktree.fetch")),
      postCreate: pick("worktree.post_create", d.worktree.postCreate, (v) => optStr(v, "worktree.post_create")),
      postCreateTimeoutSec: pick("worktree.post_create_timeout_sec", d.worktree.postCreateTimeoutSec, (v) => timeoutSec(v, "worktree.post_create_timeout_sec")),
      repos: pick("worktree.repos", d.worktree.repos, (v) => {
        if (v === null || typeof v !== "object" || Array.isArray(v)) {
          fail("worktree.repos must be a table of repo path -> settings");
        }
        const out: Record<string, Partial<WorktreeSettings>> = {};
        for (const [repo, raw] of Object.entries(v as Record<string, unknown>)) {
          if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
            fail(`worktree.repos."${repo}" must be a table`);
          }
          const o = raw as Record<string, unknown>;
          const over: Partial<WorktreeSettings> = {};
          if (o.base !== undefined) over.base = optStr(o.base, `worktree.repos."${repo}".base`);
          if (o.fetch !== undefined) over.fetch = bool(o.fetch, `worktree.repos."${repo}".fetch`);
          if (o.post_create !== undefined) over.postCreate = optStr(o.post_create, `worktree.repos."${repo}".post_create`);
          if (o.post_create_timeout_sec !== undefined) {
            over.postCreateTimeoutSec = timeoutSec(o.post_create_timeout_sec, `worktree.repos."${repo}".post_create_timeout_sec`);
          }
          // Keyed by the same absolute form the task's repo is stored in, so
          // "~/dev/x", "./x" and the real path are one repo to the lookup.
          out[path.resolve(expandTilde(repo))] = over;
        }
        return out;
      }),
    },
    linear: {
      enabled: pick("linear.enabled", d.linear.enabled, (v) => bool(v, "linear.enabled")),
      label: pick("linear.label", d.linear.label, (v) => str(v, "linear.label")),
      // 1 minute floor and a 1 day ceiling: below the floor this is hammering
      // someone else's API, above the ceiling it is not an integration.
      pollIntervalMin: pick("linear.poll_interval_min", d.linear.pollIntervalMin, (v) => num(v, "linear.poll_interval_min", { min: 1, max: 1440 })),
      repos: pick("linear.repos", d.linear.repos, (v) => {
        if (v === null || typeof v !== "object" || Array.isArray(v)) {
          fail("linear.repos must be a table of team key -> repo path");
        }
        const out: Record<string, string> = {};
        for (const [team, repo] of Object.entries(v as Record<string, unknown>)) {
          out[team] = expandTilde(str(repo, `linear.repos.${team}`));
        }
        return out;
      }),
      assignee: pick("linear.assignee", d.linear.assignee, (v) => oneOf(v, "linear.assignee", ASSIGNEES)),
      repoLabelGroup: pick("linear.repo_label_group", d.linear.repoLabelGroup, (v) => {
        if (typeof v !== "string") fail("linear.repo_label_group must be a string");
        return v; // "" is meaningful: no group axis
      }),
      repoLabelPrefix: pick("linear.repo_label_prefix", d.linear.repoLabelPrefix, (v) => {
        if (typeof v !== "string") fail("linear.repo_label_prefix must be a string");
        return v; // "" is meaningful: no per-issue override
      }),
      size: pick("linear.size", d.linear.size, (v) => oneOf(v, "linear.size", SIZES)),
      // Empty is meaningful (let the team's own workflow decide), so this one
      // takes any string rather than str()'s non-empty check.
      startState: pick("linear.start_state", d.linear.startState, (v) => {
        if (typeof v !== "string") fail("linear.start_state must be a string");
        return v;
      }),
      comment: pick("linear.comment", d.linear.comment, (v) => bool(v, "linear.comment")),
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
