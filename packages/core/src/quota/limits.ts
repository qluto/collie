/**
 * Detection of Claude Code's limit-reached messages in pane text, and parsing
 * of the reset time Claude itself prints. Verified message shapes (2026):
 *   "You've hit your session limit · resets 3:45pm"
 *   "You've hit your weekly limit · resets Mon 12:00am"
 *   "You've hit your Opus limit · resets 3:45pm"
 */

export interface LimitHit {
  kind: "session" | "weekly" | "opus";
  resetPhrase: string;
  resetAt: Date | null;
}

const LIMIT_RE = /You'?ve hit your (session|weekly|Opus)[^·\n]*limit\s*·\s*resets\s+([^\n·]+)/i;

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function detectLimitHit(paneText: string, now = new Date()): LimitHit | null {
  const m = LIMIT_RE.exec(paneText);
  if (!m) return null;
  const kind = m[1]!.toLowerCase() as LimitHit["kind"];
  const resetPhrase = m[2]!.trim().replace(/[.)\]]+$/, "");
  return { kind, resetPhrase, resetAt: parseResetPhrase(resetPhrase, now) };
}

/**
 * Parse phrases like "3:45pm", "11pm", "Mon 12:00am" into the next future
 * occurrence in local time. Returns null when the phrase is unrecognized
 * (caller should fall back to a fixed cool-down).
 */
export function parseResetPhrase(phrase: string, now = new Date()): Date | null {
  const m = /^(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(phrase.trim());
  if (!m) return null;
  const [, wd, hStr, minStr, ampm] = m;
  let hour = Number(hStr) % 12;
  if (ampm!.toLowerCase() === "pm") hour += 12;
  const minute = minStr ? Number(minStr) : 0;

  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);

  if (wd) {
    const target = WEEKDAYS.indexOf(wd.toLowerCase());
    let delta = (target - candidate.getDay() + 7) % 7;
    if (delta === 0 && candidate <= now) delta = 7;
    candidate.setDate(candidate.getDate() + delta);
  } else if (candidate <= now) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}
