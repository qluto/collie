import React from "react";
import { Box, Text } from "ink";
import { blockedUntil, loadConfig, msUntilModeChange, resolveMode } from "@collie/core";
import type { Config, LimitSnapshot, UsageSnapshot } from "@collie/core";
import type { HubSnapshot } from "../state.ts";

/**
 * Bar over the FULL limit, with `│` marking the dispatch cap. Filling toward
 * the cap instead would show 33%-of-35% as a nearly-full bar and read as "about
 * to hit the limit", which is not what it means. The unit belongs to the caller
 * (percentages vs ccusage tokens).
 */
function bar(used: number, total: number, cap: number, width = 24): string {
  // any nonzero usage gets at least one cell, so "a little" never reads as "none"
  const filled = used > 0 && total > 0
    ? Math.min(width, Math.max(1, Math.round((used / total) * width)))
    : 0;
  const cells: string[] = Array.from({ length: width }, (_, i) => (i < filled ? "█" : "░"));
  if (total > 0 && cap < total) {
    cells[Math.min(width - 1, Math.floor((cap / total) * width))] = "│";
  }
  return `[${cells.join("")}]`;
}

const fmtM = (n: number) => `${(n / 1e6).toFixed(1)}M`;

export function Dashboard(props: {
  snap: HubSnapshot;
  usage: UsageSnapshot | null;
  limits: LimitSnapshot | null;
}): React.JSX.Element {
  const { snap, usage, limits } = props;
  let config: Config | null = null;
  let configError = "";
  try {
    config = loadConfig();
  } catch (err) {
    configError = (err as Error).message;
  }
  const now = new Date();
  const mode = config ? resolveMode(config.schedule, now) : "?";
  const nextChangeMin = config ? Math.round(msUntilModeChange(config.schedule, now) / 60000) : 0;
  const hardStop = blockedUntil(snap.quota);

  const d = snap.dispatcher;
  const tickAge = d ? Math.round((Date.now() - Date.parse(d.lastTickAt)) / 1000) : null;
  const alive = d && tickAge !== null && config
    ? tickAge < config.dispatch.pollIntervalSec * 3
    : false;

  const frac = config ? (mode === "full" ? config.quota.fractionFull : config.quota.fractionConservative) : 0;
  const weekFrac = config?.quota.weekFraction ?? 0.9;

  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      <Box flexDirection="column">
        <Text bold>Quota</Text>
        {limits ? (
          <>
            {/* Anthropic's own percentages; refreshed every 10min by the dispatcher */}
            <Text color={limits.sessionPct >= frac * 100 ? "yellow" : undefined}>
              {"5h session "}
              {bar(limits.sessionPct, 100, frac * 100)}
              {` ${limits.sessionPct}%`}
              <Text dimColor>{` · cap ${Math.round(frac * 100)}%`}</Text>
            </Text>
            <Text color={limits.weeklyPct >= weekFrac * 100 ? "yellow" : undefined}>
              {"week       "}
              {bar(limits.weeklyPct, 100, weekFrac * 100)}
              {` ${limits.weeklyPct}%`}
              <Text dimColor>{` · cap ${Math.round(weekFrac * 100)}%`}</Text>
            </Text>
            <Text dimColor>
              {`measured ${Math.round((Date.now() - limits.fetchedAt) / 60_000)}m ago (claude usage API)`}
            </Text>
          </>
        ) : usage === null ? (
          <Text dimColor>loading usage…</Text>
        ) : usage.ok ? (
          <>
            <Text color="yellow">ccusage estimate — real limits unavailable</Text>
            <Text>
              {"5h block   "}
              {config ? bar(usage.blockUsedTokens, config.quota.blockBudgetTokens, config.quota.blockBudgetTokens * frac) : ""}
              {` ${fmtM(usage.blockUsedTokens)}`}
              <Text dimColor>{config ? ` · cap ${fmtM(config.quota.blockBudgetTokens * frac)} of ${fmtM(config.quota.blockBudgetTokens)}` : ""}</Text>
            </Text>
            <Text>
              {"week       "}
              {config ? bar(usage.weekUsedTokens, config.quota.weekBudgetTokens, config.quota.weekBudgetTokens * weekFrac) : ""}
              {` ${fmtM(usage.weekUsedTokens)}`}
              <Text dimColor>{config ? ` · cap ${fmtM(config.quota.weekBudgetTokens * weekFrac)} of ${fmtM(config.quota.weekBudgetTokens)}` : ""}</Text>
            </Text>
          </>
        ) : (
          <Text color="yellow">ccusage unavailable (estimates offline)</Text>
        )}
        {hardStop && (
          <Text color="red">
            LIMIT HIT ({snap.quota.lastLimitKind}) — dispatch blocked until {hardStop.toLocaleString()}
          </Text>
        )}
        {snap.quota.learnedBlockCeiling && (
          <Text dimColor>
            observed block ceiling: {(snap.quota.learnedBlockCeiling / 1e6).toFixed(1)}M — consider calibrating block_budget_tokens
          </Text>
        )}
      </Box>

      <Box flexDirection="column">
        <Text bold>Schedule</Text>
        <Text>
          mode: <Text color={mode === "full" ? "green" : mode === "paused" ? "red" : "yellow"}>{mode}</Text>
          <Text dimColor>{`  next change in ~${nextChangeMin}min`}</Text>
        </Text>
        {configError && <Text color="red">config: {configError}</Text>}
      </Box>

      <Box flexDirection="column">
        <Text bold>Dispatcher</Text>
        {d ? (
          <>
            <Text>
              {alive ? <Text color="green">● running</Text> : <Text color="red">● stale/dead</Text>}
              <Text dimColor>{`  pid ${d.pid}, last tick ${tickAge}s ago, wip ${d.wip}`}</Text>
            </Text>
            <Text wrap="truncate-end">decision: {d.lastDecision}</Text>
          </>
        ) : (
          <Text color="yellow">not running (collie dispatcher install)</Text>
        )}
      </Box>

      <Box flexDirection="column">
        <Text bold>Recent events</Text>
        {snap.journal.slice(-8).map((e, i) => (
          <Text key={i} dimColor wrap="truncate">
            {`${e.ts.slice(11, 19)} ${e.taskId.slice(-6)} ${e.from ?? "·"} → ${e.to} (${e.source})`}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
