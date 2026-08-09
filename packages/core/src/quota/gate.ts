import type { Config, ScheduleMode, Task, TaskSize } from "../types.ts";
import type { LimitSnapshot } from "./limits-api.ts";

export interface UsageSnapshot {
  /** tokens consumed in the active 5h block (ccusage estimate) */
  blockUsedTokens: number;
  /** tokens consumed in the rolling 7-day window (ccusage estimate) */
  weekUsedTokens: number;
  /** active block end time, if known */
  blockEndsAt?: string;
  /** false when ccusage could not be read — see gate policy below */
  ok: boolean;
  fetchedAt: number;
}

export interface GateDecision {
  allow: boolean;
  reason: string;
}

const SIZE_ORDER: Record<TaskSize, number> = { S: 0, M: 1, L: 2 };

export function sizeFits(size: TaskSize, max: TaskSize): boolean {
  return SIZE_ORDER[size] <= SIZE_ORDER[max];
}

/**
 * Whether a schedule mode will even consider a task, before any token math.
 * `full` takes everything; `conservative` keeps the daytime budget for the
 * human by skipping oversized tasks and anything the author marked `defer`.
 */
export function modeAdmits(
  task: Pick<Task, "defer" | "size">,
  mode: ScheduleMode,
  conservativeMaxSize: TaskSize,
): boolean {
  if (mode === "paused") return false;
  if (mode === "full") return true;
  return !task.defer && sizeFits(task.size, conservativeMaxSize);
}

const fmtM = (n: number) => `${(n / 1e6).toFixed(1)}M`;

/**
 * Preferred path: Anthropic's own utilization percentages. No token estimate,
 * no guessed denominator — the same numbers Claude Code's /usage panel shows.
 *
 * This is a threshold, not the token math's "used + estimate <= cap": there is
 * no honest way to convert a task size into a percentage yet. A task that
 * starts just under the cap can therefore cross it, which is survivable — the
 * limit-hit scraper turns that into a blockedUntil and requeues WITHOUT
 * burning an attempt. Leave headroom in the fractions rather than in a guess.
 */
export function limitsAllow(
  quota: Config["quota"],
  mode: Exclude<ScheduleMode, "paused">,
  limits: LimitSnapshot,
): GateDecision {
  const capPct = (mode === "full" ? quota.fractionFull : quota.fractionConservative) * 100;
  const weekCapPct = quota.weekFraction * 100;
  const age = `${Math.round((Date.now() - limits.fetchedAt) / 60_000)}m ago`;

  if (limits.sessionPct >= capPct) {
    return {
      allow: false,
      reason: `blocked by session limit: ${limits.sessionPct}% used, cap ${capPct}% (${mode}, measured ${age})`,
    };
  }
  if (limits.weeklyPct >= weekCapPct) {
    return {
      allow: false,
      reason: `blocked by weekly limit: ${limits.weeklyPct}% used, cap ${weekCapPct}% (measured ${age})`,
    };
  }
  return {
    allow: true,
    reason: `limits ok: session ${limits.sessionPct}%/${capPct}%, week ${limits.weeklyPct}%/${weekCapPct}% (${mode}, measured ${age})`,
  };
}

/**
 * Fallback quota decision from ccusage token estimates, used only when the real
 * percentages are unavailable. Policy when ccusage is also unreadable
 * (snapshot.ok=false): conservative mode denies; full mode allows (night runs
 * shouldn't die on a parser hiccup) — the blockedUntil hard-stop from limit
 * scraping still applies upstream either way.
 */
export function quotaAllows(
  quota: Config["quota"],
  mode: Exclude<ScheduleMode, "paused">,
  size: TaskSize,
  snap: UsageSnapshot,
): GateDecision {
  const est = quota.sizeEstimateTokens[size];
  if (!snap.ok) {
    return mode === "full"
      ? { allow: true, reason: "ccusage unavailable; allowing in full mode (blockedUntil gate still active)" }
      : { allow: false, reason: "ccusage unavailable; denying in conservative mode" };
  }
  const frac = mode === "full" ? quota.fractionFull : quota.fractionConservative;
  const blockCap = quota.blockBudgetTokens * frac;
  if (snap.blockUsedTokens + est > blockCap) {
    return {
      allow: false,
      reason: `blocked by quota: block ${fmtM(snap.blockUsedTokens)}/${fmtM(quota.blockBudgetTokens)}, need ${fmtM(est)}, cap ${fmtM(blockCap)} (${mode})`,
    };
  }
  const weekCap = quota.weekBudgetTokens * quota.weekFraction;
  if (snap.weekUsedTokens + est > weekCap) {
    return {
      allow: false,
      reason: `blocked by weekly quota: week ${fmtM(snap.weekUsedTokens)}/${fmtM(quota.weekBudgetTokens)}, need ${fmtM(est)}, cap ${fmtM(weekCap)}`,
    };
  }
  return {
    allow: true,
    reason: `quota ok: block ${fmtM(snap.blockUsedTokens)}+${fmtM(est)} <= ${fmtM(blockCap)} (${mode})`,
  };
}
