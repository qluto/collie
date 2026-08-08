import type { Config, ScheduleMode } from "./types.ts";

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Resolve the schedule mode for a local time. Windows are [start, end);
 * end earlier than start means the window crosses midnight. First matching
 * window wins; outside all windows the default mode applies.
 */
export function resolveMode(schedule: Config["schedule"], now: Date): ScheduleMode {
  const t = now.getHours() * 60 + now.getMinutes();
  for (const w of schedule.windows) {
    const start = minutesOfDay(w.start);
    const end = minutesOfDay(w.end);
    const inWindow = start <= end ? t >= start && t < end : t >= start || t < end;
    if (inWindow) return w.mode;
  }
  return schedule.defaultMode;
}

/** Milliseconds until the next window-boundary change (for dashboard display). */
export function msUntilModeChange(schedule: Config["schedule"], now: Date): number {
  const t = now.getHours() * 60 + now.getMinutes();
  const boundaries = schedule.windows
    .flatMap((w) => [minutesOfDay(w.start), minutesOfDay(w.end)])
    .map((b) => (b > t ? b - t : b + 1440 - t))
    .filter((d) => d > 0);
  const next = Math.min(...(boundaries.length ? boundaries : [1440]));
  return next * 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds());
}
