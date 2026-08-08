import React from "react";
import { Box, Text } from "ink";
import { tailEvents } from "@collie/core";
import type { Task } from "@collie/core";

export function Detail(props: { task: Task }): React.JSX.Element {
  const { task } = props;
  const events = tailEvents(20, task.id);
  const rows: Array<[string, string | undefined]> = [
    ["status", task.status],
    ["repo", task.repo],
    ["priority", String(task.priority)],
    ["size", task.size],
    ["worktree", task.worktree ? task.branch ?? "yes" : "no"],
    ["permission", task.permissionMode],
    ["attempts", `${task.attempts}/${task.maxAttempts}`],
    ["pane", task.run?.paneId],
    ["session", task.run?.sessionId?.slice(0, 8)],
    ["heartbeat", task.run?.lastHeartbeatAt],
    ["summary", task.run?.resultSummary],
    ["failure", task.run?.failureReason],
  ];
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>
        {task.id} — {task.title}
      </Text>
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <Text key={k} wrap="truncate-end">
            <Text dimColor>{k.padEnd(11)}</Text>
            {v}
          </Text>
        ))}
      <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>prompt</Text>
        {task.prompt
          .split("\n")
          .slice(0, 12)
          .map((line, i) => (
            <Text key={i} wrap="truncate">
              {line || " "}
            </Text>
          ))}
        {task.prompt.split("\n").length > 12 && <Text dimColor>… (e to open in $EDITOR)</Text>}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>history</Text>
        {events.map((e, i) => (
          <Text key={i} dimColor>
            {`${e.ts.slice(0, 19)} ${e.from ?? "·"} → ${e.to} (${e.source})`}
          </Text>
        ))}
      </Box>
      <Text dimColor>Esc back · e edit prompt · y copy pane id</Text>
    </Box>
  );
}
