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

/** Seconds since last macOS HID input; null when the probe fails (non-mac, sandbox). */
export function inputIdleSeconds(): number | null {
  if (process.platform !== "darwin") return null;
  const res = spawnSync("ioreg", ["-c", "IOHIDSystem", "-d", "4"], {
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

/**
 * Post-process the schedule-resolved mode with "is a human at this machine".
 * Presence never replaces the windows — it only nudges the mode they picked:
 *
 * - disabled                                   -> passthrough, no reason
 * - paused                                     -> passthrough (never upgraded)
 * - present && full                            -> cfg.whenPresent (downgrade)
 * - absent && absentUpgrade && conservative    -> full (opt-in upgrade)
 * - anything else                              -> passthrough
 *
 * present = keyboard touched within idleThresholdMin, or (opt-in) some other
 * agent is working in a pane collie does not own. A failed probe means
 * "unknown": only the other-agents half can fire, and an upgrade never can.
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

  if ((atKeyboard || others) && mode === "full") {
    const why = atKeyboard ? "human at keyboard" : "another agent working";
    return { mode: cfg.whenPresent, reason: `presence: ${why} → ${cfg.whenPresent}` };
  }

  const absent = idleSec !== null && idleSec >= thresholdSec && !others;
  if (absent && cfg.absentUpgrade && mode === "conservative") {
    return { mode: "full", reason: `presence: idle ${Math.round(idleSec / 60)}m → full` };
  }

  return { mode };
}
