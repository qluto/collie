import React, { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { spawnSync } from "node:child_process";
import {
  cancelTask, configPath, createTask, discoverRepos, getUsage, loadConfig, taskFilePath, transition, updateTask,
} from "@collie/core";
import type { Task, UsageSnapshot } from "@collie/core";
import { useHubSnapshot } from "./state.ts";
import { Board, COLUMNS, columnTasks } from "./views/board.tsx";
import { Dashboard } from "./views/dashboard.tsx";
import { Detail } from "./views/detail.tsx";
import { NewTaskForm, type NewTaskDraft } from "./views/newTask.tsx";
import { ConfigView } from "./views/config.tsx";
import { KEYMAP } from "./keys.ts";
import {
  ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN, editFileInEditor, editInEditor, setRepaint,
} from "./editor.ts";

type Tab = "board" | "dashboard" | "config";
type Overlay =
  | { kind: "none" }
  | { kind: "help" }
  | { kind: "detail"; taskId: string }
  | { kind: "new" }
  | { kind: "confirm-cancel"; taskId: string };

function App(): React.JSX.Element {
  const { exit } = useApp();
  const [snap, refresh] = useHubSnapshot();
  const [tab, setTab] = useState<Tab>("board");
  const [overlay, setOverlay] = useState<Overlay>({ kind: "none" });
  const [focusCol, setFocusCol] = useState(1); // start on Queued
  const [focusRow, setFocusRow] = useState(0);
  const [showFailed, setShowFailed] = useState(false);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [flash, setFlash] = useState("");
  const [rows, setRows] = useState(process.stdout.rows ?? 24);

  // fill the terminal and follow resizes
  useEffect(() => {
    const onResize = () => setRows(process.stdout.rows ?? 24);
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
    const prompt = editInEditor(`<!-- Prompt for "${draft.title}". Save & quit to create the task. -->\n\n`);
    if (prompt === null || prompt.trim().length === 0 || prompt.trim().startsWith("<!--") && prompt.trim().split("\n").length <= 2) {
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
          worktree: draft.worktree,
          permissionMode: draft.permissionMode,
          status: draft.queueNow ? "queued" : "backlog",
        },
        { source: "tui" },
      );
      flashMsg(`created ${t.id} (${t.status})`);
    });
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
      else if (input === "y" && task?.run?.paneId) {
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
    if (overlay.kind === "new") return; // form handles its own input

    // global
    if (input === "q") exit();
    else if (input === "?") setOverlay({ kind: "help" });
    else if (input === "R") refresh();
    else if (input === "1") setTab("board");
    else if (input === "2") setTab("dashboard");
    else if (input === "3") setTab("config");
    else if (tab === "config" && input === "e") {
      if (editFileInEditor(configPath())) refresh();
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
      } else if (input === "d" && task?.status === "review") {
        act(() => transition(task.id, "done", undefined, { source: "tui" }));
      } else if (input === "r" && task && (task.status === "review" || task.status === "failed")) {
        act(() => transition(task.id, "queued", undefined, { source: "tui" }));
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

  return (
    <Box flexDirection="column" height={rows}>
      <Box gap={2}>
        <Text bold color="magenta">
          collie
        </Text>
        {(["board", "dashboard", "config"] as Tab[]).map((t, i) => (
          <Text key={t} bold={tab === t} underline={tab === t} dimColor={tab !== t}>
            {`${i + 1}:${t}`}
          </Text>
        ))}
        <Text dimColor>? help</Text>
        {flash && <Text color="yellow">{flash}</Text>}
      </Box>
      {overlay.kind === "new" ? (
        <NewTaskForm
          defaults={(() => {
            try {
              const c = loadConfig();
              return { worktree: c.defaults.worktree, permissionMode: c.defaults.permissionMode };
            } catch {
              return { worktree: true, permissionMode: "acceptEdits" as const };
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
        <Detail task={detailTask} />
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
      ) : tab === "board" ? (
        <Board tasks={snap.tasks} focusCol={focusCol} focusRow={focusRow} showFailed={showFailed} now={snap.refreshedAt} />
      ) : tab === "dashboard" ? (
        <Dashboard snap={snap} usage={usage} />
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
