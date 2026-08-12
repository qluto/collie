import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Task, TaskStatus } from "@collie/core";
import { displayWidth, truncateToWidth, wrapToWidth } from "../cursor.ts";
import { JpTextInput } from "../jpTextInput.tsx";

/**
 * Every task, in the order a human deals with it: the three groups that want a
 * decision this morning (finished work, then the sessions stuck on a question —
 * they are still burning a pane — then the failures), then the two that want
 * nothing (what is in flight, what the night will pick up next).
 *
 * That second half was a separate Board tab of five kanban lanes, three of
 * which repeated the groups above with different keys bound to them (`J` was
 * jump here and priority-down there, `x` discarded a branch here and cancelled
 * a task there). One list ends the collision, and a colourless header is enough
 * to say "nothing here needs you" — the whole distinction the two tabs carried.
 *
 * Group-specific keys ride in the header, which is where 🗑 Dropped already
 * advertised its own; the footer stays the universal set.
 */
const GROUPS: Array<{ label: string; status: TaskStatus; color?: string; keys?: string }> = [
  { label: "✅ Review", status: "review", color: "green" },
  { label: "❓ Asking", status: "blocked", color: "yellow" },
  { label: "❌ Failed", status: "failed", color: "red" },
  { label: "🏃 Running", status: "running", keys: "J jump · x cancel" },
  { label: "⏳ Queued", status: "queued", keys: "e edit · [ ] reorder · x delete" },
];

/** key + what it does, so the footer can light the keys up and still read as one line. */
const FOOTER_KEYS: Array<[string, string]> = [
  ["d", "done"], ["a", "answer"], ["J", "jump"], ["o", "resume"], ["r", "retry"],
  ["Enter", "detail"], ["n", "new"],
];
const FOOTER = FOOTER_KEYS.map(([k, label]) => `${k} ${label}`).join(" · ");

/**
 * Virtual group indices past the live GROUPS. Dropped work sits between the
 * working set and the archive: it is finished, so it is not urgent, but its
 * branch is still on disk waiting for a decision, which the archive's is not.
 */
const DROPPED_G = GROUPS.length;
const ARCHIVE_G = GROUPS.length + 1;

/**
 * The flat, ordered list the view renders and app.tsx navigates. Both extra
 * groups hold tasks that have left the working set, so they never arrive
 * through `tasks`: `dropped` is done-but-never-merged (always shown, it is a
 * pending decision), `archived` only when the human opened the archive.
 */
export function orderedTasks(
  tasks: Task[],
  extra?: { dropped?: Task[]; archived?: Task[] },
): Task[] {
  return [
    ...GROUPS.flatMap((g) => tasks.filter((t) => t.status === g.status)),
    ...(extra?.dropped ?? []),
    ...(extra?.archived ?? []),
  ];
}

/** "MM-DD HH:MM", local: the archive is scanned by "when did I do this". */
function stamp(iso: string | undefined): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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

/** How long since the run last said anything — the only "is it alive" signal. */
function heartbeatBadge(t: Task, now: number): string {
  const hb = Date.parse(t.run?.lastHeartbeatAt ?? t.startedAt ?? "");
  if (!hb) return "⋯";
  const min = Math.round((now - hb) / 60000);
  return min <= 1 ? "●" : `●${min}m`;
}

/**
 * What decides when a task runs and where — the line the kanban cards carried.
 * `size` gates (it feeds the quota math), `priority` only orders the queue.
 */
function metaLine(t: Task, now: number): string {
  return [
    `p${t.priority}`,
    t.size,
    t.repo.split("/").at(-1) ?? "",
    // A task nobody typed says where it came from: "why is this queued" has a
    // different answer for an imported issue than for one you tossed in.
    t.origin?.ref ?? "",
    t.status === "running" ? heartbeatBadge(t, now) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

interface Card {
  /** index into GROUPS */
  g: number;
  title: string;
  detail: string[];
}

/**
 * One line, keys lit and their labels dim. Truncation walks the segments with a
 * running cell budget — a single truncateToWidth over the joined string would
 * lose the colouring.
 */
function Footer(props: { width: number }): React.JSX.Element {
  let left = props.width;
  const take = (s: string): string => {
    const text = truncateToWidth(s, left);
    left -= displayWidth(text);
    return text;
  };
  return (
    <Box>
      {FOOTER_KEYS.map(([key, label], i) => (
        <React.Fragment key={key}>
          <Text color="cyan">{take(i === 0 ? key : ` · ${key}`)}</Text>
          <Text dimColor>{take(` ${label}`)}</Text>
        </React.Fragment>
      ))}
    </Box>
  );
}

/** `✅ Review` in the group's colour, then everything countable in dim. */
function GroupHeader(props: { label: string; suffix: string; color?: string; width: number }): React.JSX.Element {
  const label = truncateToWidth(props.label, props.width);
  return (
    <Box>
      <Text bold color={props.color} dimColor={!props.color}>
        {label}
      </Text>
      <Text dimColor>{truncateToWidth(`  ${props.suffix}`, props.width - displayWidth(label))}</Text>
    </Box>
  );
}

function buildCards(
  tasks: Task[],
  dropped: Task[],
  archived: Task[],
  diffFor: (t: Task) => string | null,
  questionFor: (t: Task) => string | null,
  width: number,
  now: number,
): Card[] {
  const cards: Card[] = [];
  GROUPS.forEach((group, g) => {
    for (const t of tasks.filter((x) => x.status === group.status)) {
      const title = truncateToWidth(t.title, width - 2);
      const cut = (s: string) => truncateToWidth(s, width - 4);
      const detail: string[] = [];
      if (group.status === "review") {
        if (t.run?.resultSummary) detail.push(cut(t.run.resultSummary));
        const diff = diffFor(t);
        if (diff) detail.push(cut(diff));
      } else if (group.status === "blocked") {
        const scraped = questionFor(t);
        const text = scraped ? tailText(scraped) : t.run?.question ?? "";
        detail.push(...wrapToWidth(text.replace(/\s+/g, " ").trim(), width - 4, 4));
      } else if (group.status === "failed") {
        detail.push(cut(`${t.run?.failureReason ?? "failed"} · ${t.attempts}/${t.maxAttempts}`));
      } else {
        // running and queued have produced nothing to show yet, so the card
        // carries what there is to know about them instead
        detail.push(cut(metaLine(t, now)));
      }
      cards.push({ g, title, detail: detail.filter((l) => l.length > 0) });
    }
  });
  for (const t of dropped) {
    // What is still on disk, not what the session said: the branch name is the
    // thing `x` throws away, and the diff is the size of what would go with it.
    const meta = [stamp(t.endedAt ?? t.updatedAt), t.branch ?? "", diffFor(t) ?? ""].filter(Boolean);
    cards.push({
      g: DROPPED_G,
      title: truncateToWidth(t.title, width - 2),
      detail: [truncateToWidth(meta.join(" · "), width - 4)],
    });
  }
  for (const t of archived) {
    const meta = [stamp(t.endedAt ?? t.updatedAt), t.run?.resultSummary ?? ""].filter(Boolean);
    cards.push({
      g: ARCHIVE_G,
      title: truncateToWidth(t.title, width - 2),
      detail: meta.length > 0 ? [truncateToWidth(meta.join(" · "), width - 4)] : [],
    });
  }
  return cards;
}

export function TaskList(props: {
  tasks: Task[];
  focusIdx: number;
  columns?: number;
  rows?: number;
  diffFor: (t: Task) => string | null;
  questionFor: (t: Task) => string | null;
  /** done, but the branch never landed — the human dropped this work */
  dropped?: Task[];
  /** the archive's most recent tasks — empty unless it is open */
  archived?: Task[];
  /** how many tasks the archive holds in total, open or not */
  archivedTotal?: number;
  archiveOpen?: boolean;
  /** snapshot time, against which a running task's heartbeat ages */
  now?: number;
}): React.JSX.Element {
  const width = (props.columns ?? process.stdout.columns ?? 80) - 2;
  const rows = props.rows ?? process.stdout.rows ?? 24;
  const dropped = props.dropped ?? [];
  const archived = props.archiveOpen ? props.archived ?? [] : [];
  const archivedTotal = props.archivedTotal ?? 0;
  const counts = [
    ...GROUPS.map((g) => props.tasks.filter((t) => t.status === g.status).length),
    dropped.length,
    archivedTotal,
  ];
  const cards = buildCards(
    props.tasks, dropped, archived, props.diffFor, props.questionFor, width, props.now ?? Date.now(),
  );
  const headers = [
    ...GROUPS.map((g, i) => ({
      label: g.label,
      suffix: [`${counts[i]}`, g.keys].filter(Boolean).join(" · "),
      color: g.color,
    })),
    { label: "🗑 Dropped", suffix: `${dropped.length} · x discard · u reopen`, color: undefined },
    { label: "📦 Done", suffix: `${archivedTotal} · A to close`, color: undefined },
  ];
  // The one-line door to the archive, shown only while it is folded shut — the
  // same header shape it gets when open, so the eye reads them as one thing.
  const folded = !props.archiveOpen && archivedTotal > 0;
  const foldedHeader = (
    <GroupHeader label="📦 Done" suffix={`${archivedTotal} · A to open`} width={width} />
  );

  if (cards.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>no tasks — n tosses one in, and the night is young</Text>
        {folded && <Text> </Text>}
        {folded && foldedHeader}
        {rows > (folded ? 4 : 2) && <Text> </Text>}
        <Footer width={width} />
      </Box>
    );
  }

  // Rows are a hard budget — Ink has no scrolling, so anything past the last
  // row is simply gone. Every rendered line is counted here: group header,
  // title, each detail line, the overflow marker, the folded archive line and
  // the footer.
  const focus = Math.max(0, Math.min(props.focusIdx, cards.length - 1));
  const budget = Math.max(1, rows - 1 - (folded ? 1 : 0)); // footer (+ archive line)
  const groupsSpanned = new Set(cards.map((c) => c.g)).size;
  const full = cards.reduce((sum, c) => sum + 1 + c.detail.length, 0) + groupsSpanned;
  // Breathing room — a blank line between groups, above the folded archive and
  // above the footer — is the first thing to go: it is only affordable when the
  // whole list already fits, so a crowded morning spends every row on
  // content instead.
  const airy = full + groupsSpanned + (folded ? 1 : 0) <= budget;
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
      const newGroup = c.g !== g;
      // the window's first header sits at the top of the view: no blank above it
      const gap = airy && newGroup && end > start ? 1 : 0;
      const add = (newGroup ? 1 : 0) + gap + 1 + Math.min(c.detail.length, maxDetail);
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
        const header = c.g !== prevGroup ? headers[c.g]! : null;
        prevGroup = c.g;
        const selected = idx === focus;
        return (
          <React.Fragment key={idx}>
            {header !== null && airy && i > 0 && <Text> </Text>}
            {header !== null && (
              <GroupHeader label={header.label} suffix={header.suffix} color={header.color} width={width} />
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
      {folded && airy && <Text> </Text>}
      {folded && foldedHeader}
      {airy && <Text> </Text>}
      <Footer width={width} />
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
