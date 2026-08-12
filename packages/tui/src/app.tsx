import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_CONFIG, blockedUntil, cancelTask, computeForecast, configPath, createTask, diffSummary,
  discardTaskWork, discoverRepos, droppedTasks, forecastLine, formatClock, listArchived, loadConfig,
  markDone, modeLabel, readLimits, refreshBranchScan, refreshLimits, resolveMode, retryTask, runsDir,
  stripPromptTemplate, taskFilePath, transition, updateTask,
} from "@collie/core";
import type { Config, LimitSnapshot, Task } from "@collie/core";
import { useHubSnapshot, type HubSnapshot } from "./state.ts";
import { Detail } from "./views/detail.tsx";
import { AnswerForm, TaskList, orderedTasks } from "./views/tasks.tsx";
import { NewTaskForm, type NewTaskDraft } from "./views/newTask.tsx";
import { ConfigView } from "./views/config.tsx";
import { KEYMAP } from "./keys.ts";
import { reorderPlan } from "./queue.ts";
import { displayWidth, truncateToWidth } from "./cursor.ts";
import { focusPane } from "./jump.ts";
import { openSession } from "./session.ts";
import { answerPane } from "./answer.ts";
import {
  ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN, editFileInEditor, editInEditor, setRepaint,
} from "./editor.ts";

type Tab = "tasks" | "config";
const TABS: Tab[] = ["tasks", "config"];

/**
 * Below this the tab bar drops the wordmark and the help hint. Sized for a
 * phone terminal (herdr's own mobile layout kicks in around 64) — it used to be
 * the width at which five kanban lanes stopped holding a title, which is a
 * question one vertical list never has to answer.
 */
const NARROW_COLUMNS = 70;
type Overlay =
  | { kind: "none" }
  | { kind: "help" }
  | { kind: "detail"; taskId: string }
  | { kind: "new" }
  | { kind: "answer"; taskId: string }
  | { kind: "confirm-cancel"; taskId: string }
  | { kind: "confirm-discard"; taskId: string };

/**
 * The task cards want a git shortstat and a scraped pane per task, both of
 * which are far too expensive for the 2s snapshot poll (diffSummary is a
 * spawnSync). Cache on `id:rev` — a task that changed gets a fresh answer —
 * with a TTL for the work that happens outside the task file (commits landing
 * in the worktree while the task sits in review).
 */
const CACHE_TTL_MS = 60_000;

/** How far back the opened archive reaches. Ink cannot scroll; the rest is `… +N`. */
const ARCHIVE_LIMIT = 20;
const evidenceCache = new Map<string, { at: number; value: string | null }>();

function cached(key: string, compute: () => string | null): string | null {
  const hit = evidenceCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  let value: string | null = null;
  try {
    value = compute();
  } catch {
    // no evidence is a fine answer; the card just renders one line less
  }
  if (evidenceCache.size > 200) evidenceCache.clear();
  evidenceCache.set(key, { at: Date.now(), value });
  return value;
}

function diffFor(task: Task): string | null {
  return cached(`diff:${task.id}:${task.rev}`, () =>
    diffSummary(task.repo, task.branch, task.run?.worktreePath));
}

/** Tail of the pane text the dispatcher scraped behind a blocked task. */
function questionFor(task: Task): string | null {
  if (task.status !== "blocked" || !task.run?.questionScrapedAt) return null;
  return cached(`q:${task.id}:${task.rev}`, () => {
    const text = fs.readFileSync(path.join(runsDir(task.id), "question.txt"), "utf8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    return lines.slice(-10).join("\n");
  });
}

interface HeaderSegment {
  text: string;
  color?: string;
  dim?: boolean;
}

/**
 * The always-on budget line: is the dog awake and in which mode, any hard stop
 * a scraped limit hit imposed, then how much of tonight is left in tasks. Cut
 * to the terminal width here — a wrapped header would steal a row the views
 * below already budgeted for.
 */
function forecastHeader(
  snap: HubSnapshot,
  config: Config,
  limits: LimitSnapshot | null,
  columns: number,
): HeaderSegment[] {
  const mode = resolveMode(config.schedule, new Date());
  const tickAgeSec = snap.dispatcher
    ? (Date.now() - Date.parse(snap.dispatcher.lastTickAt)) / 1000
    : null;
  const alive = tickAgeSec !== null && tickAgeSec < config.dispatch.pollIntervalSec * 3;

  const segments: HeaderSegment[] = [
    alive
      ? {
          text: `● ${modeLabel(mode, config.quota.conservativeMaxSize)}`,
          color: mode === "paused" ? "yellow" : "green",
        }
      : { text: "○ dead", color: "red" },
  ];
  const hardStop = blockedUntil(snap.quota);
  if (hardStop) segments.push({ text: `⛔ until ${formatClock(hardStop)}`, color: "red" });
  if (!limits) {
    segments.push({ text: "limits unavailable — ccusage fallback", dim: true });
  } else if (mode !== "paused") {
    const f = computeForecast(config.quota, mode, limits, config.forecast.sessionPctPerTask);
    segments.push({
      text: forecastLine(f, limits.weeklyPct, config.quota.weekFraction * 100),
      dim: true,
    });
  }

  let left = columns;
  return segments.map((s, i) => {
    const text = truncateToWidth(i === 0 ? s.text : `  ${s.text}`, left);
    left -= displayWidth(text);
    return { ...s, text };
  });
}

function App(): React.JSX.Element {
  const { exit } = useApp();
  const [tab, setTab] = useState<Tab>("tasks");
  const [overlay, setOverlay] = useState<Overlay>({ kind: "none" });
  // pause background refresh while a text field owns the hardware cursor
  const [snap, refresh] = useHubSnapshot(overlay.kind === "new" || overlay.kind === "answer");
  const [focusIdx, setFocusIdx] = useState(0); // task list cursor
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [limits, setLimits] = useState<LimitSnapshot | null>(null);
  const [flash, setFlash] = useState("");
  const [rows, setRows] = useState(process.stdout.rows ?? 24);
  const [columns, setColumns] = useState(process.stdout.columns ?? 80);
  const narrow = columns < NARROW_COLUMNS;

  // fill the terminal and follow resizes
  useEffect(() => {
    const onResize = () => {
      setRows(process.stdout.rows ?? 24);
      setColumns(process.stdout.columns ?? 80);
    };
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);

  // Real limit percentages, feeding the always-on forecast header. refreshLimits
  // is a no-op inside its 10min window, so this mostly reads the file the
  // dispatcher already wrote.
  useEffect(() => {
    const pull = () => {
      setLimits(readLimits());
      void refreshLimits().then((r) => r.snapshot && setLimits(r.snapshot));
    };
    pull();
    const t = setInterval(pull, 60_000);
    return () => clearInterval(t);
  }, []);

  // Done tasks live outside the snapshot on purpose: snap.tasks is the working
  // set the list and the dispatcher reason about. Folded, this is one
  // readdir per tick; only an open archive pays for parsing.
  const archive = useMemo(
    () => listArchived(archiveOpen ? ARCHIVE_LIMIT : 0),
    [snap.refreshedAt, archiveOpen],
  );

  // Done tasks whose branch never landed. The scan behind this is git-side and
  // file-cached (branches.ts): re-running it on every 2s snapshot costs one
  // JSON read, and the dispatcher's tick usually refreshed it already.
  const dropped = useMemo(() => droppedTasks(), [snap.refreshedAt]);

  // config.toml is a file read: once per snapshot, not once per keystroke
  const config = useMemo(() => {
    try {
      return loadConfig();
    } catch {
      return DEFAULT_CONFIG; // the Config tab is where an invalid file gets reported
    }
  }, [snap.refreshedAt]);

  const flashMsg = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(""), 3000);
  };

  const act = (fn: () => void) => {
    try {
      fn();
      refresh();
    } catch (err) {
      flashMsg((err as Error).message);
    }
  };

  /**
   * Back into a finished task's conversation. The pane it ran in is usually
   * gone by now (adoption closes it), so this makes a new one — what survives
   * is the session id, and `claude --resume` finds it from anywhere.
   */
  const reopenSession = (task: Task) => {
    if (!task.run?.sessionId) {
      flashMsg(`${task.id} recorded no session`);
      return;
    }
    flashMsg(`resuming ${task.run.sessionId.slice(0, 8)}…`);
    void openSession(task)
      .then((paneId) => flashMsg(`resumed in ${paneId}`))
      .catch((err) => flashMsg(`resume failed: ${(err as Error).message}`));
  };

  /** Move a queued task one place; see reorderPlan for why it renumbers. */
  const reorderQueued = (task: Task, earlier: boolean): boolean => {
    const plan = reorderPlan(snap.tasks.filter((t) => t.status === "queued"), task.id, earlier);
    if (!plan) return false;
    for (const w of plan) {
      updateTask(w.id, (t) => {
        t.priority = w.priority;
      });
    }
    return true;
  };

  const openPromptEditor = (task: Task) => {
    if (editFileInEditor(taskFilePath(task.id))) refresh();
    else flashMsg("editor exited non-zero; file unchanged");
  };

  const submitNewTask = (draft: NewTaskDraft) => {
    setOverlay({ kind: "none" });
    const raw = editInEditor(`<!-- Prompt for "${draft.title}". Save & quit to create the task. -->\n\n`);
    if (raw === null) {
      flashMsg("editor exited non-zero; task not created");
      return;
    }
    const prompt = stripPromptTemplate(raw);
    if (prompt.length === 0) {
      flashMsg("empty prompt; task not created");
      return;
    }
    act(() => {
      // worktree/permissionMode come from config defaults inside createTask —
      // a toss-in never answers them
      const t = createTask(
        {
          title: draft.title,
          repo: draft.repo,
          prompt,
          size: draft.size,
        },
        { source: "tui" },
      );
      flashMsg(`created ${t.id} (${t.status})`);
    });
  };

  const submitAnswer = (taskId: string, text: string) => {
    setOverlay({ kind: "none" });
    if (text.trim().length === 0) return; // empty = cancel
    const paneId = snap.tasks.find((t) => t.id === taskId)?.run?.paneId;
    if (!paneId) {
      flashMsg(`${taskId} has no pane to answer`);
      return;
    }
    void answerPane(paneId, text)
      .then(() => flashMsg(`answered ${taskId}`))
      .catch((err) => flashMsg(`answer failed: ${(err as Error).message}`));
  };

  useInput((input, key) => {
    // overlays capture input first
    if (overlay.kind === "help") {
      if (input === "?" || key.escape || input === "q") setOverlay({ kind: "none" });
      return;
    }
    if (overlay.kind === "detail") {
      const task = snap.tasks.find((t) => t.id === overlay.taskId);
      if (key.escape || input === "q") setOverlay({ kind: "none" });
      else if (input === "o") {
        // the archive is where this matters most, so resolve there too
        const t = task ?? archive.tasks.find((x) => x.id === overlay.taskId)
          ?? dropped.find((x) => x.id === overlay.taskId);
        if (t) reopenSession(t);
      } else if (input === "e" && task) openPromptEditor(task);
      else if (input === "g" && task?.run?.paneId) {
        const paneId = task.run.paneId;
        flashMsg(`jumping to ${paneId}…`);
        void focusPane(paneId).catch((err) => flashMsg(`jump failed: ${(err as Error).message}`));
      } else if (input === "y" && task?.run?.paneId) {
        spawnSync("pbcopy", { input: task.run.paneId });
        flashMsg(`copied ${task.run.paneId}`);
      }
      return;
    }
    if (overlay.kind === "confirm-cancel") {
      if (input === "y") {
        const queued = snap.tasks.find((t) => t.id === overlay.taskId)?.status === "queued";
        act(() => cancelTask(overlay.taskId, { source: "tui" }));
        setOverlay({ kind: "none" });
        flashMsg(queued ? `deleted ${overlay.taskId}` : "cancelled (pane left alive for inspection)");
      } else if (key.escape || input === "n") setOverlay({ kind: "none" });
      return;
    }
    if (overlay.kind === "confirm-discard") {
      if (input === "y") {
        const task = dropped.find((t) => t.id === overlay.taskId);
        setOverlay({ kind: "none" });
        if (!task) return;
        const res = discardTaskWork(task);
        // The card is gone the moment the branch is: nothing else defines it.
        refreshBranchScan({ maxAgeSec: 0 });
        refresh();
        flashMsg(res.ok ? res.message : `discard failed: ${res.message}`);
      } else if (key.escape || input === "n") setOverlay({ kind: "none" });
      return;
    }
    if (overlay.kind === "new" || overlay.kind === "answer") return; // forms handle their own input

    // global
    if (input === "q") exit();
    else if (input === "?") setOverlay({ kind: "help" });
    else if (input === "R") refresh();
    else if (input === "1") setTab("tasks");
    else if (input === "2") setTab("config");
    else if (tab === "config" && input === "e") {
      if (editFileInEditor(configPath())) refresh();
    } else if (tab === "tasks") {
      const items = orderedTasks(snap.tasks, { dropped, archived: archive.tasks });
      const idx = Math.min(focusIdx, items.length - 1);
      const task = items[idx];
      const isDropped = !!task && dropped.some((d) => d.id === task.id);
      if (input === "A") {
        setArchiveOpen((v) => !v);
      } else if (input === "j" || key.downArrow) {
        setFocusIdx((i) => Math.min(Math.max(items.length - 1, 0), i + 1));
      } else if (input === "k" || key.upArrow) {
        setFocusIdx((i) => Math.max(0, i - 1));
      } else if (input === "n") {
        setOverlay({ kind: "new" });
      } else if (key.return && task) {
        setOverlay({ kind: "detail", taskId: task.id });
      } else if (input === "o" && task) {
        reopenSession(task);
      } else if (input === "J" && task) {
        // shift, because j/k are list movement everywhere in this TUI
        const paneId = task.run?.paneId;
        // A finished task's pane is reclaimed on adoption, so the jump has
        // somewhere to go only while the session is still live.
        if (!paneId) flashMsg(`${task.id} has no pane — o resumes its session`);
        else {
          flashMsg(`jumping to ${paneId}…`);
          void focusPane(paneId).catch((err) => flashMsg(`jump failed: ${(err as Error).message}`));
        }
      } else if (input === "d" && task) {
        if (task.status === "review") act(() => markDone(task.id, { source: "tui" }));
        else flashMsg("d promotes a reviewed task to done");
      } else if (input === "a" && task) {
        if (task.status === "blocked" && task.run?.paneId) setOverlay({ kind: "answer", taskId: task.id });
        else flashMsg("a answers a task blocked on a question");
      } else if (input === "r" && task && (task.status === "review" || task.status === "failed")) {
        act(() => retryTask(task.id, { source: "tui" }));
      } else if (input === "e" && task) {
        // A queued prompt is still editable; a started one is history.
        if (task.status === "queued") openPromptEditor(task);
        else flashMsg("e edits a queued task's prompt");
      } else if ((input === "[" || input === "]") && task) {
        // j/k are list movement everywhere in this TUI and J is the jump, so
        // the queue's own axis gets brackets: earlier ← [ ] → later. The cursor
        // follows the card it moved, or holding the key walks a different task
        // every press.
        const earlier = input === "[";
        if (task.status === "queued") {
          act(() => {
            if (reorderQueued(task, earlier)) setFocusIdx(earlier ? Math.max(0, idx - 1) : idx + 1);
          });
        } else flashMsg("[ ] reorder a queued task");
      } else if (input === "x" && task) {
        // One meaning — throw this away — and the confirm dialog spells out
        // what that costs for the group the cursor is actually on.
        if (isDropped) setOverlay({ kind: "confirm-discard", taskId: task.id });
        else if (snap.tasks.some((t) => t.id === task.id)) {
          setOverlay({ kind: "confirm-cancel", taskId: task.id });
        } else flashMsg(`${task.id} is already done`);
      } else if (input === "u" && task) {
        // Back into the working set: the archived file walks out of the archive
        // (store.transition), so the task lands in ✅ Review with its pane info.
        if (isDropped) act(() => transition(task.id, "review", undefined, { source: "tui" }));
        else flashMsg("u reopens a dropped task");
      }
    }
  });

  const detailTask =
    overlay.kind === "detail"
      ? snap.tasks.find((t) => t.id === overlay.taskId) ??
        dropped.find((t) => t.id === overlay.taskId) ??
        archive.tasks.find((t) => t.id === overlay.taskId)
      : undefined;
  const answerTask =
    overlay.kind === "answer" ? snap.tasks.find((t) => t.id === overlay.taskId) : undefined;

  // Second header line: is the dog awake, and how much of tonight is left.
  // Overlays suppress it — the new-task and answer forms anchor the hardware
  // cursor to screen rows counted from the top (REPO_ROW, ANSWER_INPUT_ROW),
  // and an extra line above them would move the input out from under the IME.
  const headerLine =
    overlay.kind === "none" ? forecastHeader(snap, config, limits, columns) : null;
  const bodyRows = rows - (headerLine ? 2 : 1);

  return (
    <Box flexDirection="column" height={rows}>
      {/* the wordmark and the help hint are the first things to go on a phone —
          a wrapped header would eat a row the list below budgeted for */}
      <Box gap={narrow ? 1 : 2}>
        {!narrow && <Text>🐑🐑🐕</Text>}
        {TABS.map((t, i) => (
          <Text key={t} bold={tab === t} underline={tab === t} dimColor={tab !== t}>
            {`${i + 1}:${narrow ? t.slice(0, 4) : t}`}
          </Text>
        ))}
        {!narrow && <Text dimColor>? help</Text>}
        {flash && (
          <Text color="yellow" wrap="truncate">
            {flash}
          </Text>
        )}
      </Box>
      {headerLine && (
        <Box>
          {headerLine.map((s, i) => (
            <Text key={i} color={s.color} dimColor={s.dim}>
              {s.text}
            </Text>
          ))}
        </Box>
      )}
      {overlay.kind === "answer" && answerTask ? (
        <AnswerForm
          task={answerTask}
          question={questionFor(answerTask) ?? answerTask.run?.question ?? ""}
          columns={columns}
          onSubmit={(text) => submitAnswer(answerTask.id, text)}
          onCancel={() => setOverlay({ kind: "none" })}
        />
      ) : overlay.kind === "new" ? (
        <NewTaskForm
          knownRepos={(() => {
            let discovered: string[] = [];
            try {
              discovered = discoverRepos(config.repos.roots);
            } catch {
              // unreadable roots: fall back to recent-task repos only
            }
            // recent-task repos first (most likely targets), then the rest
            const recent = [...new Set(snap.tasks.map((t) => t.repo))];
            return [...recent, ...discovered.filter((r) => !recent.includes(r))];
          })()}
          onSubmit={submitNewTask}
          onCancel={() => setOverlay({ kind: "none" })}
        />
      ) : overlay.kind === "detail" && detailTask ? (
        <Detail task={detailTask} columns={columns} rows={bodyRows} />
      ) : overlay.kind === "help" ? (
        <Box flexDirection="column" paddingX={1} borderStyle="round">
          {KEYMAP.map((k) => (
            <Text key={`${k.context}-${k.keys}-${k.action}`}>
              <Text color="cyan">{k.keys.padEnd(12)}</Text>
              {k.action}
              <Text dimColor>{`  (${k.context})`}</Text>
            </Text>
          ))}
        </Box>
      ) : tab === "tasks" ? (
        <TaskList
          tasks={snap.tasks}
          focusIdx={focusIdx}
          columns={columns}
          rows={bodyRows}
          diffFor={diffFor}
          questionFor={questionFor}
          dropped={dropped}
          archived={archive.tasks}
          archivedTotal={archive.total}
          archiveOpen={archiveOpen}
          now={snap.refreshedAt}
        />
      ) : (
        <ConfigView columns={columns} rows={bodyRows} />
      )}
      {overlay.kind === "confirm-discard" && (
        <Box borderStyle="round" borderColor="red" paddingX={1}>
          <Text>
            {`delete ${dropped.find((t) => t.id === overlay.taskId)?.branch ?? "branch"}, its commits and its worktree? `}
            <Text bold>y</Text>/n
          </Text>
        </Box>
      )}
      {overlay.kind === "confirm-cancel" && (
        <Box borderStyle="round" borderColor="red" paddingX={1}>
          <Text>
            {snap.tasks.find((t) => t.id === overlay.taskId)?.status === "queued"
              ? `delete queued task ${overlay.taskId}? `
              : `cancel ${overlay.taskId}? running panes are left alive. `}
            <Text bold>y</Text>/n
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function runTui(): void {
  // Full-screen: take over the alternate screen buffer (like vim/htop) and
  // give the shell back untouched on exit.
  process.stdout.write(ENTER_ALT_SCREEN);
  const instance = render(<App />, { exitOnCtrlC: true });
  setRepaint(() => instance.clear());
  const restore = () => process.stdout.write(LEAVE_ALT_SCREEN);
  process.on("exit", restore);
  void instance.waitUntilExit().then(() => {
    restore();
    process.exit(0);
  });
}
