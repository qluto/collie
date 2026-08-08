import type { Config, ScheduleMode, TaskSize } from "../types.ts";

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

const fmtM = (n: number) => `${(n / 1e6).toFixed(1)}M`;

/**
 * Pure quota decision. Policy when ccusage is unreadable (snapshot.ok=false):
 * conservative mode denies; full mode allows (night runs shouldn't die on a
 * parser hiccup) — the blockedUntil hard-stop from limit scraping still
 * applies upstream either way.
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
  const weekCap = quota.weekBudgetTokens * 0.9;
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
