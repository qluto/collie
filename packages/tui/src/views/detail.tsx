import React from "react";
import { Box, Text } from "ink";
import { tailEvents } from "@collie/core";
import type { Task } from "@collie/core";
import { truncateToWidth, wrapToWidth } from "../cursor.ts";

const LABEL = 11;

export function Detail(props: { task: Task; columns?: number; rows?: number }): React.JSX.Element {
  const { task } = props;
  // Every line is cut to the pane width here rather than left to Ink: a wrapped
  // line shifts everything below it and the repaint lands on top of the
  // previous frame, which on a phone-width pane looks like corruption.
  const width = (props.columns ?? process.stdout.columns ?? 80) - 2;
  const height = props.rows ?? process.stdout.rows ?? 24;
  const narrow = width < 60;

  const events = tailEvents(narrow ? 4 : 20, task.id);
  const rows: Array<[string, string | undefined]> = [
    ["status", task.status],
    ["repo", narrow ? task.repo.split("/").at(-1) : task.repo],
    ["priority", String(task.priority)],
    ["size", task.size],
    ["defer", task.defer ? "yes (full windows only)" : undefined],
    ["worktree", task.worktree ? task.branch ?? "yes" : "no"],
    ["permission", task.permissionMode],
    ["attempts", `${task.attempts}/${task.maxAttempts}`],
    ["pane", task.run?.paneId],
    ["session", task.run?.sessionId?.slice(0, 8)],
    ["heartbeat", narrow ? task.run?.lastHeartbeatAt?.slice(11, 19) : task.run?.lastHeartbeatAt],
    ["summary", task.run?.resultSummary],
    ["failure", task.run?.failureReason],
  ];
  const shown = rows.filter(([, v]) => v);

  // title + fields + history + footer; whatever is left goes to the prompt box
  const promptLines = Math.max(
    0,
    height - (narrow ? 2 : 1) - shown.length - events.length - (narrow ? 5 : 7),
  );
  const prompt = wrapToWidth(task.prompt.replace(/\s+/g, " ").trim(), width - 4, Math.max(1, promptLines));

  return (
    <Box flexDirection="column" paddingX={1}>
      {wrapToWidth(`${task.id} — ${task.title}`, width, narrow ? 2 : 1).map((line, i) => (
        <Text key={i} bold>
          {line}
        </Text>
      ))}
      {shown.map(([k, v]) => (
        <Text key={k}>
          <Text dimColor>{k.padEnd(LABEL)}</Text>
          {truncateToWidth(v!, width - LABEL)}
        </Text>
      ))}
      {promptLines > 0 && (
        <Box marginTop={1} flexDirection="column" width={width} borderStyle="round" borderColor="gray" paddingX={1}>
          <Text dimColor>prompt</Text>
          {prompt.map((line, i) => (
            <Text key={i}>{line || " "}</Text>
          ))}
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>history</Text>
        {events.map((e, i) => (
          <Text key={i} dimColor>
            {truncateToWidth(`${e.ts.slice(narrow ? 11 : 0, 19)} ${e.from ?? "·"} → ${e.to} (${e.source})`, width)}
          </Text>
        ))}
      </Box>
      <Text dimColor>
        {truncateToWidth(
          `Esc back · e edit${task.run?.paneId ? " · g jump · y copy" : ""}`,
          width,
        )}
      </Text>
    </Box>
  );
}
