import React from "react";
import { Box, Text } from "ink";
import type { Task } from "@collie/core";
import type { TaskStatus } from "@collie/core";
import { truncateToWidth, wrapToWidth } from "../cursor.ts";

export const COLUMNS: Array<{ title: string; statuses: TaskStatus[] }> = [
  { title: "Backlog", statuses: ["backlog"] },
  { title: "Queued", statuses: ["queued"] },
  { title: "Running", statuses: ["running"] },
  { title: "Blocked", statuses: ["blocked"] },
  { title: "Review", statuses: ["review"] },
  { title: "Done", statuses: ["done"] }, // toggles to failed via 'f'
];

// Six columns across a normal terminal leave ~14 cells each — too narrow for a
// Japanese title. The focused column takes FOCUS_SHARE of the row instead, so
// whatever the cursor is on is actually readable.
const FOCUS_SHARE = 3;
const MAX_FOCUS = 56;

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

/** Second card line: everything that isn't the title, in one dim run. */
function metaLine(t: Task, now: number): string {
  const repo = t.repo.split("/").at(-1) ?? "";
  return [
    `p${t.priority}`,
    `${t.size}${t.defer ? "☾" : ""}`,
    repo,
    t.run?.failureReason ? `!${t.run.failureReason.split(":")[0]}` : "",
  ]
    .filter(Boolean)
    .join(" ") + heartbeatBadge(t, now);
}

function Card(props: { task: Task; selected: boolean; width: number; now: number }): React.JSX.Element {
  const { task, selected, width, now } = props;
  // Narrow (unfocused) columns are a scannable list of titles: a second line of
  // metadata there would be truncated to noise and halve how many cards fit.
  const titleLines = wrapToWidth(task.title, width, width >= 24 ? 2 : 1);
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {titleLines.map((line, i) => (
        <Text key={i} inverse={selected} wrap="truncate">
          {line}
        </Text>
      ))}
      {width >= 16 && (
        <Text dimColor wrap="truncate">
          {truncateToWidth(metaLine(task, now), width)}
        </Text>
      )}
    </Box>
  );
}

/**
 * Below this many columns six side-by-side lanes cannot hold a readable title
 * even with the accordion, so the board stacks them instead. Sized for a phone
 * terminal (herdr's own mobile layout kicks in around 64).
 */
export const NARROW_COLUMNS = 70;

/**
 * Stacked lanes for narrow terminals. Ink has no scrolling — anything past the
 * last row is simply gone — so this budgets rows explicitly: empty lanes shrink
 * to their header, the focused lane is served first, and a lane that had to
 * drop cards says so rather than silently ending.
 */
function StackedBoard(props: {
  tasks: Task[];
  focusCol: number;
  focusRow: number;
  showFailed: boolean;
  now: number;
  width: number;
  rows: number;
}): React.JSX.Element {
  const { tasks, focusCol, focusRow, showFailed, now, width, rows } = props;
  const lanes = COLUMNS.map((col, ci) => ({
    ci,
    title: ci === 5 && showFailed ? "Failed" : col.title,
    items: columnTasks(tasks, ci, showFailed),
    focused: ci === focusCol,
  })).filter((l) => l.items.length > 0 || l.focused);

  // Rows are a hard budget: a lane costs 1 (header) + its cards + 1 more when it
  // had to drop some ("… +N") — that last row is easy to forget and is what
  // pushes the bottom lane off the screen.
  const shown = new Map<number, number>(lanes.map((l) => [l.ci, l.items.length]));
  const visible = [...lanes];
  const dropped: typeof lanes = [];
  const height = () =>
    visible.reduce((sum, l) => {
      const n = shown.get(l.ci)!;
      return sum + 1 + n + (n < l.items.length ? 1 : 0) + (l.focused && n > 0 ? 1 : 0);
    }, 0) + (dropped.length > 0 ? 1 : 0);

  while (height() > rows) {
    // shrink the fullest lane first, never below the selected card
    const victim = visible
      .filter((l) => shown.get(l.ci)! > (l.focused ? 1 : 0))
      .sort((a, b) => shown.get(b.ci)! - shown.get(a.ci)!)[0];
    if (victim) {
      shown.set(victim.ci, shown.get(victim.ci)! - 1);
      continue;
    }
    // every lane is down to its floor: drop whole lanes from the bottom, keeping
    // the focused one, and summarise them in a single line rather than vanishing
    let last = -1;
    for (let i = visible.length - 1; i >= 0; i--) if (!visible[i]!.focused) { last = i; break; }
    if (last < 0) break;
    dropped.unshift(visible.splice(last, 1)[0]!);
  }

  const textWidth = width - 2;
  return (
    <Box flexDirection="column" flexGrow={1}>
      {visible.map((lane) => {
        const n = shown.get(lane.ci)!;
        // when the focused card scrolled past the budget, show the window around it
        const start = lane.focused ? Math.max(0, Math.min(focusRow - n + 1, lane.items.length - n)) : 0;
        const hidden = lane.items.length - n - start;
        return (
          <Box key={lane.title} flexDirection="column">
            <Text bold color={lane.focused ? "cyan" : undefined} wrap="truncate">
              {`${lane.focused ? "▸" : " "} ${lane.title} ${lane.items.length}`}
              {start > 0 ? <Text dimColor>{` ↑${start}`}</Text> : ""}
            </Text>
            {lane.items.slice(start, start + n).map((t, i) => {
              const selected = lane.focused && start + i === focusRow;
              return (
                <React.Fragment key={t.id}>
                  <Text inverse={selected} wrap="truncate">
                    {`  ${truncateToWidth(t.title, textWidth - 2)}`}
                  </Text>
                  {selected && (
                    <Text dimColor wrap="truncate">
                      {`  ${truncateToWidth(metaLine(t, now), textWidth - 2)}`}
                    </Text>
                  )}
                </React.Fragment>
              );
            })}
            {hidden > 0 && <Text dimColor>{`  … +${hidden}`}</Text>}
            {lane.items.length === 0 && <Text dimColor>{"  (empty)"}</Text>}
          </Box>
        );
      })}
      {dropped.length > 0 && (
        <Text dimColor wrap="truncate">
          {truncateToWidth(`… ${dropped.map((l) => `${l.title} ${l.items.length}`).join(" · ")}`, textWidth)}
        </Text>
      )}
    </Box>
  );
}

export function Board(props: {
  tasks: Task[];
  focusCol: number;
  focusRow: number;
  showFailed: boolean;
  now: number;
  /** terminal columns; the card text is laid out against this */
  columns?: number;
  /** terminal rows available to the board; only used by the stacked layout */
  rows?: number;
}): React.JSX.Element {
  const { tasks, focusCol, focusRow, showFailed, now } = props;
  // Column boxes get explicit widths rather than flexGrow: the card text is
  // truncated by us (Ink miscounts CJK), so the layout must not be free to
  // round differently than this arithmetic did.
  const total = props.columns ?? process.stdout.columns ?? 80;
  if (total < NARROW_COLUMNS) {
    return (
      <StackedBoard
        tasks={tasks}
        focusCol={focusCol}
        focusRow={focusRow}
        showFailed={showFailed}
        now={now}
        width={total}
        rows={props.rows ?? process.stdout.rows ?? 24}
      />
    );
  }
  const shares = COLUMNS.length - 1 + FOCUS_SHARE;
  const avail = total - (COLUMNS.length - 1); // one cell of gap between columns
  const others = COLUMNS.length - 1;
  let narrow = Math.max(9, Math.floor(avail / shares));
  // past MAX_FOCUS the focused column stops growing and the width goes to the
  // other columns instead — a 90-cell card is no more readable than a 56-cell one
  if (avail - narrow * others > MAX_FOCUS) narrow = Math.floor((avail - MAX_FOCUS) / others);
  const widthFor = (ci: number) =>
    ci === focusCol ? Math.max(narrow, avail - narrow * others) : narrow;

  return (
    <Box flexGrow={1} gap={1}>
      {COLUMNS.map((col, ci) => {
        const items = columnTasks(tasks, ci, showFailed);
        const title = ci === 5 && showFailed ? "Failed" : col.title;
        const focused = ci === focusCol;
        const boxWidth = widthFor(ci);
        const width = boxWidth - 3; // 2 border cells + the card's left padding
        return (
          <Box
            key={col.title}
            flexDirection="column"
            width={boxWidth}
            flexShrink={0}
            borderStyle="round"
            borderColor={focused ? "cyan" : "gray"}
          >
            <Text bold color={focused ? "cyan" : undefined} wrap="truncate">
              {/* the count is the scanning signal: truncate the name, never the number */}
              {` ${truncateToWidth(title, Math.max(3, boxWidth - 4 - String(items.length).length))} ${items.length}`}
            </Text>
            {items.map((t, ri) => (
              <Card key={t.id} task={t} selected={focused && ri === focusRow} width={width} now={now} />
            ))}
            {items.length === 0 && <Text dimColor>{"  (empty)"}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
