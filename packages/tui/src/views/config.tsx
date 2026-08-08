import React from "react";
import { Box, Text } from "ink";
import { configPath, loadConfig } from "@agent-hub/core";

export function ConfigView(): React.JSX.Element {
  let body: React.JSX.Element;
  try {
    const c = loadConfig();
    body = (
      <>
        <Text>{`dispatch: wip ${c.dispatch.wipLimit}, poll ${c.dispatch.pollIntervalSec}s, idle grace ${c.dispatch.idleGraceMin}min, ready timeout ${c.dispatch.readyTimeoutSec}s`}</Text>
        <Text>
          {"schedule: "}
          {c.schedule.windows.map((w) => `${w.start}-${w.end}=${w.mode}`).join(", ") || "(no windows)"}
          {`, default=${c.schedule.defaultMode}`}
        </Text>
        <Text>{`quota: block ${(c.quota.blockBudgetTokens / 1e6).toFixed(0)}M (full ×${c.quota.fractionFull} / cons ×${c.quota.fractionConservative}), week ${(c.quota.weekBudgetTokens / 1e6).toFixed(0)}M`}</Text>
        <Text>{`       sizes S/M/L = ${(c.quota.sizeEstimateTokens.S / 1e6).toFixed(0)}/${(c.quota.sizeEstimateTokens.M / 1e6).toFixed(0)}/${(c.quota.sizeEstimateTokens.L / 1e6).toFixed(0)}M, conservative max ${c.quota.conservativeMaxSize}`}</Text>
        <Text>{`defaults: permission ${c.defaults.permissionMode}, worktree ${c.defaults.worktree ? "on" : "off"} (${c.defaults.worktreeRoot})`}</Text>
        <Text>{`herdr: ${c.herdr.socketPath}`}</Text>
      </>
    );
  } catch (err) {
    body = <Text color="red">{(err as Error).message}</Text>;
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Config</Text>
      <Text dimColor>{configPath()}</Text>
      <Box flexDirection="column" marginTop={1}>{body}</Box>
      <Box marginTop={1}>
        <Text dimColor>e edit in $EDITOR (dispatcher reloads on next tick)</Text>
      </Box>
    </Box>
  );
}
