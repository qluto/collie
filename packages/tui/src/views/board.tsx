import React from "react";
import { Box, Text } from "ink";
import type { Task, TaskStatus } from "@agent-hub/core";

export const COLUMNS: Array<{ title: string; statuses: TaskStatus[] }> = [
  { title: "Backlog", statuses: ["backlog"] },
  { title: "Queued", statuses: ["queued"] },
  { title: "Running", statuses: ["running"] },
  { title: "Blocked", statuses: ["blocked"] },
  { title: "Review", statuses: ["review"] },
  { title: "Done", statuses: ["done"] }, // toggles to failed via 'f'
];

export function columnTasks(tasks: Task[], col: number, showFailed: boolean): Task[] {
  const statuses = col === 5 && showFailed ? (["failed"] as TaskStatus[]) : COLUMNS[col]!.statuses;
  return tasks.filter((t) => statuses.includes(t.status));
}

function heartbeatBadge(t: Task, now: number): string {
  if (t.status !== "running") return "";
  const hb = Date.parse(t.run?.lastHeartbeatAt ?? t.startedAt ?? "");
  if (!hb) return " ⋯";
  const min = Math.round((now - hb) / 60000);
  return min <= 1 ? " ●" : ` ●${min}m`;
}

export function Board(props: {
  tasks: Task[];
  focusCol: number;
  focusRow: number;
  showFailed: boolean;
  now: number;
}): React.JSX.Element {
  const { tasks, focusCol, focusRow, showFailed, now } = props;
  return (
    <Box flexGrow={1} gap={1}>
      {COLUMNS.map((col, ci) => {
        const items = columnTasks(tasks, ci, showFailed);
        const title = ci === 5 && showFailed ? "Failed" : col.title;
        const focused = ci === focusCol;
        return (
          <Box
            key={col.title}
            flexDirection="column"
            flexBasis={0}
            flexGrow={1}
            borderStyle="round"
            borderColor={focused ? "cyan" : "gray"}
          >
            <Text bold color={focused ? "cyan" : undefined}>
              {" "}{title} ({items.length})
            </Text>
            {items.map((t, ri) => {
              const sel = focused && ri === focusRow;
              return (
                <Box key={t.id} flexDirection="column" paddingLeft={1}>
                  <Text inverse={sel} wrap="truncate">
                    {`p${t.priority} ${t.size} ${t.title}`}
                    {heartbeatBadge(t, now)}
                  </Text>
                  <Text dimColor wrap="truncate">
                    {`  ${t.repo.split("/").at(-1)} ${t.id.slice(-4)}${t.run?.failureReason ? ` !${t.run.failureReason.slice(0, 18)}` : ""}`}
                  </Text>
                </Box>
              );
            })}
            {items.length === 0 && <Text dimColor>{"  (empty)"}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
