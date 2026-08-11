import { spawnSync } from "node:child_process";
import type { Config, ScheduleMode } from "./types.ts";

/** Parse `ioreg -c IOHIDSystem -d 4` output: "HIDIdleTime" = 123456789 (ns). */
export function parseHidIdleNs(ioregOut: string): number | null {
  // The key repeats across nested nodes; the first is the IOHIDSystem entry.
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioregOut);
  if (!m) return null;
  const ns = Number(m[1]);
  return Number.isFinite(ns) ? ns : null;
}

/**
 * Seconds since last macOS HID input; null when the probe fails (non-mac, sandbox).
 *
 * ioreg is addressed ABSOLUTELY: it lives in /usr/sbin, which a login shell has
 * on PATH and launchd does not — under the plist the bare name resolved to
 * ENOENT, so the dispatcher read every human at the keyboard as "unknown" while
 * `collie doctor`, run from a terminal, reported the probe healthy.
 */
export function inputIdleSeconds(): number | null {
  if (process.platform !== "darwin") return null;
  const res = spawnSync("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (res.status !== 0 || !res.stdout) return null;
  const ns = parseHidIdleNs(res.stdout);
  return ns === null ? null : ns / 1e9;
}

export interface PresenceSignals {
  /** null = probe unavailable, which must never be read as "absent". */
  idleSec: number | null;
  othersWorking: boolean;
}

/** How much work a mode admits; presence only ever moves DOWN this ladder. */
const STRICTNESS: Record<ScheduleMode, number> = { paused: 0, conservative: 1, full: 2 };

/**
 * Post-process the schedule-resolved mode with "is a human at this machine".
 * Presence never replaces the windows — it only nudges the mode they picked:
 *
 * - disabled                                   -> passthrough, no reason
 * - paused                                     -> passthrough (never upgraded)
 * - present                                    -> mode capped at cfg.whenPresent
 * - absent && absentUpgrade && conservative    -> full (opt-in upgrade)
 * - probe unavailable                          -> passthrough, but SAYS so
 * - anything else                              -> passthrough
 *
 * present = keyboard touched within idleThresholdMin, or (opt-in) some other
 * agent is working in a pane collie does not own. A failed probe means
 * "unknown": only the other-agents half can fire, and an upgrade never can.
 *
 * whenPresent is a CEILING on every window, not a rewrite of `full` alone: the
 * common setup is a conservative default_mode with a nightly full window, and
 * capping only `full` left presence inert for the entire working day — a human
 * typing at 10:00 still got tasks dispatched at them. Presence reports itself
 * even when the cap does not bind, because "on but doing nothing" is exactly
 * the state that was impossible to tell apart from "off".
 */
export function applyPresence(
  mode: ScheduleMode,
  signals: PresenceSignals,
  cfg: Config["presence"],
): { mode: ScheduleMode; reason?: string } {
  if (!cfg.enabled) return { mode };
  if (mode === "paused") return { mode };

  const idleSec = signals.idleSec;
  const thresholdSec = cfg.idleThresholdMin * 60;
  const atKeyboard = idleSec !== null && idleSec < thresholdSec;
  const others = cfg.respectOtherAgents && signals.othersWorking;

  if (atKeyboard || others) {
    const why = atKeyboard ? "human at keyboard" : "another agent working";
    if (STRICTNESS[cfg.whenPresent] < STRICTNESS[mode]) {
      return { mode: cfg.whenPresent, reason: `presence: ${why} → ${cfg.whenPresent}` };
    }
    return { mode, reason: `presence: ${why} (already ${mode})` };
  }

  const absent = idleSec !== null && idleSec >= thresholdSec;
  if (absent && cfg.absentUpgrade && mode === "conservative") {
    return { mode: "full", reason: `presence: idle ${Math.round(idleSec / 60)}m → full` };
  }

  // A dead probe is not "absent", and it must not pass silently: presence that
  // never fires reads exactly like presence being off, which is how a
  // PATH-less ioreg dispatched work at a human sitting right there.
  if (idleSec === null) return { mode, reason: "presence: input probe unavailable" };

  return { mode };
}
