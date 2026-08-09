import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Task, TaskStatus } from "@collie/core";
import { truncateToWidth, wrapToWidth } from "../cursor.ts";
import { JpTextInput } from "../jpTextInput.tsx";

/**
 * The morning harvest: what the night produced, in the order a human deals
 * with it — finished work first, then the sessions stuck on a question (they
 * are still burning a pane), then the failures.
 */
const GROUPS: Array<{ label: string; status: TaskStatus }> = [
  { label: "✅ Review", status: "review" },
  { label: "❓ Asking", status: "blocked" },
  { label: "✗ Failed", status: "failed" },
];

const FOOTER = "d done · a answer · J jump · r retry · Enter detail · n new";

/** The flat, ordered list the view renders and app.tsx navigates. */
export function harvestList(tasks: Task[]): Task[] {
  return GROUPS.flatMap((g) => tasks.filter((t) => t.status === g.status));
}

/**
 * Last readable lines of a scraped pane, as one paragraph. The scrape is raw
 * screen text: its blank and box-drawing rows carry nothing here and would
 * spend the card's whole line budget.
 */
function tailText(scraped: string, maxLines = 6): string {
  const lines = scraped
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[\s─-╿>·]+$/.test(l));
  return lines.slice(-maxLines).join(" ").replace(/\s+/g, " ").trim();
}

interface Card {
  /** index into GROUPS */
  g: number;
  title: string;
  detail: string[];
}

function buildCards(
  tasks: Task[],
  diffFor: (t: Task) => string | null,
  questionFor: (t: Task) => string | null,
  width: number,
): Card[] {
  const cards: Card[] = [];
  GROUPS.forEach((group, g) => {
    for (const t of tasks.filter((x) => x.status === group.status)) {
      const title = truncateToWidth(t.title, width - 2);
      const detail: string[] = [];
      if (group.status === "review") {
        if (t.run?.resultSummary) detail.push(truncateToWidth(t.run.resultSummary, width - 4));
        const diff = diffFor(t);
        if (diff) detail.push(truncateToWidth(diff, width - 4));
      } else if (group.status === "blocked") {
        const scraped = questionFor(t);
        const text = scraped ? tailText(scraped) : t.run?.question ?? "";
        detail.push(...wrapToWidth(text.replace(/\s+/g, " ").trim(), width - 4, 4));
      } else {
        detail.push(
          truncateToWidth(
            `${t.run?.failureReason ?? "failed"} · ${t.attempts}/${t.maxAttempts}`,
            width - 4,
          ),
        );
      }
      cards.push({ g, title, detail: detail.filter((l) => l.length > 0) });
    }
  });
  return cards;
}

export function Harvest(props: {
  tasks: Task[];
  focusIdx: number;
  columns?: number;
  rows?: number;
  diffFor: (t: Task) => string | null;
  questionFor: (t: Task) => string | null;
}): React.JSX.Element {
  const width = (props.columns ?? process.stdout.columns ?? 80) - 2;
  const rows = props.rows ?? process.stdout.rows ?? 24;
  const counts = GROUPS.map((g) => props.tasks.filter((t) => t.status === g.status).length);
  const cards = buildCards(props.tasks, props.diffFor, props.questionFor, width);

  if (cards.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>nothing to harvest — the night is young</Text>
        <Text dimColor>{truncateToWidth(FOOTER, width)}</Text>
      </Box>
    );
  }

  // Rows are a hard budget — Ink has no scrolling, so anything past the last
  // row is simply gone. Every rendered line is counted here: group header,
  // title, each detail line, the overflow marker and the footer.
  const focus = Math.max(0, Math.min(props.focusIdx, cards.length - 1));
  const budget = Math.max(1, rows - 1); // footer
  const groupsSpanned = new Set(cards.map((c) => c.g)).size;
  const full = cards.reduce((sum, c) => sum + 1 + c.detail.length, 0) + groupsSpanned;
  const avail = full <= budget ? budget : budget - 1; // reserve the "… +N" row
  const maxDetail = Math.max(0, avail - 2);

  // Slide the window down until the focused card is inside it.
  let start = 0;
  let end = 0;
  for (;;) {
    let used = 0;
    let g = -1;
    end = start;
    while (end < cards.length) {
      const c = cards[end]!;
      const add = (c.g !== g ? 1 : 0) + 1 + Math.min(c.detail.length, maxDetail);
      if (used + add > avail) break;
      used += add;
      g = c.g;
      end++;
    }
    if (end > focus || start >= focus) break;
    start++;
  }
  const hidden = start + (cards.length - end);

  let prevGroup = -1;
  return (
    <Box flexDirection="column" paddingX={1}>
      {cards.slice(start, end).map((c, i) => {
        const idx = start + i;
        const header = c.g !== prevGroup ? `${GROUPS[c.g]!.label} ${counts[c.g]}` : null;
        prevGroup = c.g;
        const selected = idx === focus;
        return (
          <React.Fragment key={idx}>
            {header !== null && (
              <Text bold wrap="truncate">
                {truncateToWidth(header, width)}
              </Text>
            )}
            <Text color={selected ? "cyan" : undefined} bold={selected} wrap="truncate">
              {`${selected ? "▸" : " "} ${c.title}`}
            </Text>
            {c.detail.slice(0, maxDetail).map((line, li) => (
              <Text key={li} dimColor wrap="truncate">
                {`    ${line}`}
              </Text>
            ))}
          </React.Fragment>
        );
      })}
      {hidden > 0 && <Text dimColor>{`… +${hidden} more`}</Text>}
      <Text dimColor>{truncateToWidth(FOOTER, width)}</Text>
    </Box>
  );
}

// Fixed overlay geometry (1-indexed screen cells) for hardware-cursor
// placement: row 1 header, row 2 box border, row 3 title, rows 4-9 the
// question, row 10 the input; the value starts after "│ " (2 cells) + "> ".
// The question block is padded to exactly QUESTION_LINES so the input row
// cannot move under it — an IME preedit anchors to that cell.
const QUESTION_LINES = 6;
const ANSWER_INPUT_ROW = 10;
const ANSWER_INPUT_COL = 5;

/** Type an answer back into a blocked agent's own input box. */
export function AnswerForm(props: {
  task: Task;
  question: string;
  columns?: number;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState("");
  useInput((_input, key) => {
    if (key.escape) props.onCancel();
  });

  const width = (props.columns ?? process.stdout.columns ?? 80) - 4;
  // the question may be a raw pane scrape; same cleanup the cards use
  const lines = wrapToWidth(tailText(props.question, QUESTION_LINES), width, QUESTION_LINES);
  while (lines.length < QUESTION_LINES) lines.push("");

  return (
    <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="cyan">
      <Text bold>{truncateToWidth(`answer ${props.task.id} — ${props.task.title}`, width)}</Text>
      {lines.map((line, i) => (
        <Text key={i} dimColor>
          {line || " "}
        </Text>
      ))}
      <Box>
        <Text dimColor>{"> "}</Text>
        <JpTextInput
          value={value}
          onChange={setValue}
          onSubmit={() => props.onSubmit(value)}
          row={ANSWER_INPUT_ROW}
          col={ANSWER_INPUT_COL}
        />
      </Box>
      <Text dimColor>Enter sends · Esc (or empty Enter) cancels</Text>
    </Box>
  );
}
