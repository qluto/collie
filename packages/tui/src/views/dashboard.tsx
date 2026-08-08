import React from "react";
import { Box, Text } from "ink";
import { blockedUntil, loadConfig, msUntilModeChange, resolveMode } from "@collie/core";
import type { Config, UsageSnapshot } from "@collie/core";
import type { HubSnapshot } from "../state.ts";

function gauge(used: number, cap: number, width = 24): string {
  const ratio = cap > 0 ? Math.min(used / cap, 1) : 0;
  const filled = Math.round(ratio * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${(used / 1e6).toFixed(1)}M / ${(cap / 1e6).toFixed(0)}M`;
}

export function Dashboard(props: { snap: HubSnapshot; usage: UsageSnapshot | null }): React.JSX.Element {
  const { snap, usage } = props;
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

  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      <Box flexDirection="column">
        <Text bold>Quota</Text>
        {usage === null ? (
          <Text dimColor>loading usage…</Text>
        ) : usage.ok ? (
          <>
            <Text>
              {"5h block  "}
              {config ? gauge(usage.blockUsedTokens, config.quota.blockBudgetTokens * frac) : ""}
              <Text dimColor>{`  (cap = budget × ${frac})`}</Text>
            </Text>
            <Text>
              {"week      "}
              {config ? gauge(usage.weekUsedTokens, config.quota.weekBudgetTokens * 0.9) : ""}
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
