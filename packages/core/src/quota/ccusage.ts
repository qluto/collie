import { spawnSync } from "node:child_process";
import type { UsageSnapshot } from "./gate.ts";

const CACHE_TTL_MS = 60_000;
let cache: UsageSnapshot | undefined;

/** Command prefix, overridable for tests (e.g. a fixture script). */
function ccusageBin(): string {
  return process.env.COLLIE_CCUSAGE_BIN ?? "bunx ccusage";
}

function runJson(args: string): unknown {
  const res = spawnSync("/bin/sh", ["-c", `${ccusageBin()} ${args}`], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (res.status !== 0 || !res.stdout) {
    throw new Error(`ccusage ${args} failed: ${res.stderr?.slice(0, 200) ?? "no output"}`);
  }
  return JSON.parse(res.stdout);
}

interface CcusageBlock {
  isActive?: boolean;
  isGap?: boolean;
  totalTokens?: number;
  endTime?: string;
}

/**
 * ccusage-based usage estimate: active 5h-block tokens + rolling-7-day total.
 * Estimates are client-side and include cache reads at full weight; budgets in
 * config are calibrated against the SAME metric (observed ceilings), so
 * consistency matters more than absolute accuracy. Cached 60s.
 */
export function getUsage(now = Date.now()): UsageSnapshot {
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache;
  try {
    const blocksRes = runJson("blocks --json") as { blocks?: CcusageBlock[] };
    const active = (blocksRes.blocks ?? []).find((b) => b.isActive && !b.isGap);

    const since = new Date(now - 7 * 24 * 3600_000);
    const sinceArg = since.toISOString().slice(0, 10).replaceAll("-", "");
    const dailyRes = runJson(`daily --json --since ${sinceArg}`) as { daily?: Array<{ totalTokens?: number }> };
    const weekUsed = (dailyRes.daily ?? []).reduce((sum, d) => sum + (d.totalTokens ?? 0), 0);

    cache = {
      blockUsedTokens: active?.totalTokens ?? 0,
      weekUsedTokens: weekUsed,
      blockEndsAt: active?.endTime,
      ok: true,
      fetchedAt: now,
    };
  } catch {
    cache = { blockUsedTokens: 0, weekUsedTokens: 0, ok: false, fetchedAt: now };
  }
  return cache;
}

/** Test hook: drop the in-memory cache. */
export function clearUsageCache(): void {
  cache = undefined;
}
