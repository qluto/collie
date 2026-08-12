import type { Config, ScheduleMode, TaskSize } from "../types.ts";
import type { LimitSnapshot } from "./limits-api.ts";
import { effectiveSessionFraction } from "./gate.ts";

/**
 * "How much of tonight is left", in the one unit a human plans with: tasks.
 * Pure — the caller supplies the resolved mode and the limits snapshot, so this
 * is safe on the TUI's render path.
 */
export interface Forecast {
  /** current session utilization, 0-100 */
  sessionPct: number;
  /** dispatch cap for the resolved mode, 0-100 */
  capPct: number;
  /** max(0, capPct - sessionPct) */
  headroomPct: number;
  /** parsed sessionResetsAt, when the endpoint reported a usable one */
  resetsAt?: Date;
  /** minutes until that reset; never negative (a stale reset reads as "now") */
  minToReset?: number;
  /** headroom / pctPerTask, floored; null when pctPerTask cannot divide */
  tasksLeft: number | null;
  /** capPct is the relaxed burn-down cap, not the standing one */
  burning: boolean;
}

export function computeForecast(
  quota: Config["quota"],
  mode: Exclude<ScheduleMode, "paused">,
  limits: LimitSnapshot,
  pctPerTask: number,
  now = Date.now(),
): Forecast {
  // Same cap limitsAllow (gate.ts) applies, from the same function: the header
  // must never promise headroom the gate would refuse to spend.
  const { frac, burning } = effectiveSessionFraction(quota, mode, limits, now);
  const capPct = frac * 100;
  const headroomPct = Math.max(0, capPct - limits.sessionPct);

  let resetsAt: Date | undefined;
  let minToReset: number | undefined;
  if (typeof limits.sessionResetsAt === "string" && limits.sessionResetsAt.length > 0) {
    const parsed = new Date(limits.sessionResetsAt);
    if (!Number.isNaN(parsed.getTime())) {
      resetsAt = parsed;
      minToReset = Math.max(0, Math.round((parsed.getTime() - now) / 60_000));
    }
  }

  return {
    sessionPct: limits.sessionPct,
    capPct,
    headroomPct,
    resetsAt,
    minToReset,
    tasksLeft: pctPerTask > 0 ? Math.floor(headroomPct / pctPerTask) : null,
    burning,
  };
}

/**
 * A schedule mode as what it will actually pick up, not as its own name.
 *
 * `full`/`conservative`/`paused` are gate vocabulary: they say which lever is
 * pulled, never what it does, and abbreviated to fit a header ("cons") they say
 * nothing at all. What the mode decides is exactly one thing a human already
 * answered — the S/M/L the new-task form asked for — so the header reports it
 * in those terms. The config file and the Config tab still name the modes; that
 * tab is where the two are shown side by side.
 */
export function modeLabel(mode: ScheduleMode, conservativeMaxSize: TaskSize): string {
  if (mode === "paused") return "paused";
  return mode === "full" ? "any size" : `up to ${conservativeMaxSize}`;
}

/** Local wall-clock HH:MM — the reset time only means anything in the user's day. */
export function formatClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

/** Weekly is only worth a slot in the line once it is this close to its cap. */
const WEEKLY_INTEREST_PCT = 15;

/**
 * One compact line for the always-on TUI header, e.g.
 * `session 42% · resets 02:00 (+3h10m) · headroom 43% ≈5 tasks`.
 */
export function forecastLine(f: Forecast, weeklyPct: number, weekCapPct: number): string {
  // Leading, not trailing: the header is truncated to the terminal width from
  // the right, and a raised cap is the one thing that must survive the cut.
  const parts: string[] = [];
  if (f.burning) parts.push("⌛ burn-down");
  parts.push(`session ${Math.round(f.sessionPct)}%`);
  if (f.resetsAt && f.minToReset !== undefined) {
    parts.push(`resets ${formatClock(f.resetsAt)} (+${formatDuration(f.minToReset)})`);
  }
  const tasks = f.tasksLeft === null ? "" : ` ≈${f.tasksLeft} task${f.tasksLeft === 1 ? "" : "s"}`;
  parts.push(`headroom ${Math.round(f.headroomPct)}%${tasks}`);
  if (weeklyPct >= weekCapPct - WEEKLY_INTEREST_PCT) parts.push(`wk ${Math.round(weeklyPct)}%`);
  return parts.join(" · ");
}
