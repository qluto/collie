import React, { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  cancelTask, configPath, createTask, diffSummary, discoverRepos, getUsage, loadConfig, markDone,
  readLimits, refreshLimits, retryTask, runsDir, stripPromptTemplate, taskFilePath, transition,
  updateTask,
} from "@collie/core";
import type { LimitSnapshot, Task, UsageSnapshot } from "@collie/core";
import { useHubSnapshot } from "./state.ts";
import { Board, COLUMNS, NARROW_COLUMNS, columnTasks } from "./views/board.tsx";
import { Dashboard } from "./views/dashboard.tsx";
import { Detail } from "./views/detail.tsx";
import { AnswerForm, Harvest, harvestList } from "./views/harvest.tsx";
import { NewTaskForm, type NewTaskDraft } from "./views/newTask.tsx";
import { ConfigView } from "./views/config.tsx";
import { KEYMAP } from "./keys.ts";
import { focusPane } from "./jump.ts";
import { answerPane } from "./answer.ts";
import {
  ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN, editFileInEditor, editInEditor, setRepaint,
} from "./editor.ts";

type Tab = "harvest" | "board" | "dashboard" | "config";
const TABS: Tab[] = ["harvest", "board", "dashboard", "config"];
type Overlay =
  | { kind: "none" }
  | { kind: "help" }
  | { kind: "detail"; taskId: string }
  | { kind: "new" }
  | { kind: "answer"; taskId: string }
  | { kind: "confirm-cancel"; taskId: string };

/**
 * The harvest cards want a git shortstat and a scraped pane per task, both of
 * which are far too expensive for the 2s snapshot poll (diffSummary is a
 * spawnSync). Cache on `id:rev` — a task that changed gets a fresh answer —
 * with a TTL for the work that happens outside the task file (commits landing
 * in the worktree while the task sits in review).
 */
const CACHE_TTL_MS = 60_000;
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

function App(): React.JSX.Element {
  const { exit } = useApp();
  const [tab, setTab] = useState<Tab>("harvest");
  const [overlay, setOverlay] = useState<Overlay>({ kind: "none" });
  // pause background refresh while a text field owns the hardware cursor
  const [snap, refresh] = useHubSnapshot(overlay.kind === "new" || overlay.kind === "answer");
  const [focusCol, setFocusCol] = useState(1); // start on Queued
  const [focusRow, setFocusRow] = useState(0);
  const [focusIdx, setFocusIdx] = useState(0); // harvest list cursor
  const [showFailed, setShowFailed] = useState(false);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
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

  // usage gauge refresh (ccusage subprocess, 60s core cache) — dashboard only
  useEffect(() => {
    if (tab !== "dashboard") return;
    setUsage(getUsage());
    const t = setInterval(() => setUsage(getUsage()), 60_000);
    return () => clearInterval(t);
  }, [tab]);

  // Real limit percentages. refreshLimits is a no-op inside its 10min window, so
  // this mostly reads the file the dispatcher already wrote.
  useEffect(() => {
    if (tab !== "dashboard") return;
    const pull = () => {
      setLimits(readLimits());
      void refreshLimits().then((r) => r.snapshot && setLimits(r.snapshot));
    };
    pull();
    const t = setInterval(pull, 60_000);
    return () => clearInterval(t);
  }, [tab]);

  const flashMsg = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(""), 3000);
  };

  const focusedTask = (): Task | undefined =>
    columnTasks(snap.tasks, focusCol, showFailed)[focusRow];

  const act = (fn: () => void) => {
    try {
      fn();
      refresh();
    } catch (err) {
      flashMsg((err as Error).message);
    }
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
      const t = createTask(
        {
          title: draft.title,
          repo: draft.repo,
          prompt,
          size: draft.size,
          defer: draft.defer,
          worktree: draft.worktree,
          permissionMode: draft.permissionMode,
          status: draft.queueNow ? "queued" : "backlog",
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
      else if (input === "e" && task) openPromptEditor(task);
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
        act(() => cancelTask(overlay.taskId, { source: "tui" }));
        setOverlay({ kind: "none" });
        flashMsg("cancelled (pane left alive for inspection)");
      } else if (key.escape || input === "n") setOverlay({ kind: "none" });
      return;
    }
    if (overlay.kind === "new" || overlay.kind === "answer") return; // forms handle their own input

    // global
    if (input === "q") exit();
    else if (input === "?") setOverlay({ kind: "help" });
    else if (input === "R") refresh();
    else if (input === "1") setTab("harvest");
    else if (input === "2") setTab("board");
    else if (input === "3") setTab("dashboard");
    else if (input === "4") setTab("config");
    else if (tab === "config" && input === "e") {
      if (editFileInEditor(configPath())) refresh();
    } else if (tab === "harvest") {
      const items = harvestList(snap.tasks);
      const task = items[Math.min(focusIdx, items.length - 1)];
      if (input === "j" || key.downArrow) {
        setFocusIdx((i) => Math.min(Math.max(items.length - 1, 0), i + 1));
      } else if (input === "k" || key.upArrow) {
        setFocusIdx((i) => Math.max(0, i - 1));
      } else if (input === "n") {
        setOverlay({ kind: "new" });
      } else if (key.return && task) {
        setOverlay({ kind: "detail", taskId: task.id });
      } else if (input === "J" && task) {
        // shift, because j/k are list movement everywhere in this TUI
        const paneId = task.run?.paneId;
        if (!paneId) flashMsg(`${task.id} has no pane`);
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
      }
    } else if (tab === "board") {
      const items = columnTasks(snap.tasks, focusCol, showFailed);
      const task = focusedTask();
      if (input === "h" || key.leftArrow) {
        setFocusCol((c) => Math.max(0, c - 1));
        setFocusRow(0);
      } else if (input === "l" || key.rightArrow) {
        setFocusCol((c) => Math.min(COLUMNS.length - 1, c + 1));
        setFocusRow(0);
      } else if (input === "j" || key.downArrow) {
        setFocusRow((r) => Math.min(Math.max(items.length - 1, 0), r + 1));
      } else if (input === "k" || key.upArrow) {
        setFocusRow((r) => Math.max(0, r - 1));
      } else if (input === "f") {
        setShowFailed((f) => !f);
        if (focusCol === 5) setFocusRow(0);
      } else if (input === "n") {
        setOverlay({ kind: "new" });
      } else if (key.return && task) {
        setOverlay({ kind: "detail", taskId: task.id });
      } else if (input === " " && task) {
        if (task.status === "backlog") act(() => transition(task.id, "queued", undefined, { source: "tui" }));
        else if (task.status === "queued") act(() => transition(task.id, "backlog", undefined, { source: "tui" }));
      } else if (input === "e" && task && (task.status === "backlog" || task.status === "queued")) {
        openPromptEditor(task);
      } else if (input === "D" && task && (task.status === "backlog" || task.status === "queued")) {
        act(() => {
          const next = updateTask(task.id, (t) => {
            t.defer = !t.defer;
          });
          flashMsg(next.defer ? `${next.id} deferred (full windows only)` : `${next.id} dispatchable anytime`);
        });
      } else if (input === "d" && task?.status === "review") {
        act(() => transition(task.id, "done", undefined, { source: "tui" }));
      } else if (input === "r" && task && (task.status === "review" || task.status === "failed")) {
        act(() => retryTask(task.id, { source: "tui" }));
      } else if (input === "x" && task && task.status !== "done") {
        setOverlay({ kind: "confirm-cancel", taskId: task.id });
      } else if ((input === "J" || input === "K") && task?.status === "queued") {
        act(() => {
          const queued = columnTasks(snap.tasks, 1, false);
          const idx = queued.findIndex((t) => t.id === task.id);
          const swapWith = queued[input === "J" ? idx + 1 : idx - 1];
          if (!swapWith) return;
          const a = task.priority;
          const b = swapWith.priority;
          updateTask(task.id, (t) => {
            t.priority = a === b ? b + (input === "J" ? 1 : -1) : b;
          });
          if (a !== b) updateTask(swapWith.id, (t) => {
            t.priority = a;
          });
          setFocusRow((r) => (input === "J" ? r + 1 : Math.max(0, r - 1)));
        });
      }
    }
  });

  const detailTask =
    overlay.kind === "detail" ? snap.tasks.find((t) => t.id === overlay.taskId) : undefined;
  const answerTask =
    overlay.kind === "answer" ? snap.tasks.find((t) => t.id === overlay.taskId) : undefined;

  return (
    <Box flexDirection="column" height={rows}>
      {/* the wordmark and the help hint are the first things to go on a phone —
          a wrapped header would eat a row the stacked board budgeted for */}
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
          defaults={(() => {
            try {
              const c = loadConfig();
              return { worktree: c.defaults.worktree, permissionMode: c.defaults.permissionMode };
            } catch {
              return { worktree: true, permissionMode: "auto" as const };
            }
          })()}
          knownRepos={(() => {
            let discovered: string[] = [];
            try {
              discovered = discoverRepos(loadConfig().repos.roots);
            } catch {
              // invalid config: fall back to recent-task repos only
            }
            // recent-task repos first (most likely targets), then the rest
            const recent = [...new Set(snap.tasks.map((t) => t.repo))];
            return [...recent, ...discovered.filter((r) => !recent.includes(r))];
          })()}
          onSubmit={submitNewTask}
          onCancel={() => setOverlay({ kind: "none" })}
        />
      ) : overlay.kind === "detail" && detailTask ? (
        <Detail task={detailTask} columns={columns} rows={rows - 1} />
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
      ) : tab === "harvest" ? (
        <Harvest
          tasks={snap.tasks}
          focusIdx={focusIdx}
          columns={columns}
          rows={rows - 1}
          diffFor={diffFor}
          questionFor={questionFor}
        />
      ) : tab === "board" ? (
        <Board tasks={snap.tasks} focusCol={focusCol} focusRow={focusRow} showFailed={showFailed} now={snap.refreshedAt} columns={columns} rows={rows - 1} />
      ) : tab === "dashboard" ? (
        <Dashboard snap={snap} usage={usage} limits={limits} />
      ) : (
        <ConfigView />
      )}
      {overlay.kind === "confirm-cancel" && (
        <Box borderStyle="round" borderColor="red" paddingX={1}>
          <Text>
            cancel {overlay.taskId}? running panes are left alive. <Text bold>y</Text>/n
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
