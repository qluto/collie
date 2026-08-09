import type { Config, ScheduleMode } from "../types.ts";
import type { LimitSnapshot } from "./limits-api.ts";

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
}

export function computeForecast(
  quota: Config["quota"],
  mode: Exclude<ScheduleMode, "paused">,
  limits: LimitSnapshot,
  pctPerTask: number,
  now = Date.now(),
): Forecast {
  // Same arithmetic as limitsAllow (gate.ts): the header must never promise
  // headroom the gate would refuse to spend.
  const capPct = (mode === "full" ? quota.fractionFull : quota.fractionConservative) * 100;
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
  };
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
  const parts = [`session ${Math.round(f.sessionPct)}%`];
  if (f.resetsAt && f.minToReset !== undefined) {
    parts.push(`resets ${formatClock(f.resetsAt)} (+${formatDuration(f.minToReset)})`);
  }
  const tasks = f.tasksLeft === null ? "" : ` ≈${f.tasksLeft} task${f.tasksLeft === 1 ? "" : "s"}`;
  parts.push(`headroom ${Math.round(f.headroomPct)}%${tasks}`);
  if (weeklyPct >= weekCapPct - WEEKLY_INTEREST_PCT) parts.push(`wk ${Math.round(weeklyPct)}%`);
  return parts.join(" · ");
}
