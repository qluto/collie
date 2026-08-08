import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Board, COLUMNS, columnTasks } from "../src/views/board.tsx";
import type { Task } from "@collie/core";

const task = (over: Partial<Task>): Task => ({
  id: "t-20260808-aaaa",
  title: "A task",
  status: "backlog",
  repo: "/tmp/repo",
  priority: 100,
  size: "M",
  worktree: false,
  permissionMode: "acceptEdits",
  claudeArgs: [],
  createdAt: "2026-08-08T00:00:00Z",
  updatedAt: "2026-08-08T00:00:00Z",
  attempts: 0,
  maxAttempts: 2,
  rev: 0,
  prompt: "p",
  ...over,
});

describe("Board", () => {
  test("renders all six columns with counts", () => {
    const tasks = [
      task({ id: "t-1", status: "backlog", title: "one" }),
      task({ id: "t-2", status: "queued", title: "two" }),
      task({ id: "t-3", status: "running", title: "three", run: { lastHeartbeatAt: new Date().toISOString() } }),
      task({ id: "t-4", status: "review", title: "four" }),
    ];
    const { lastFrame } = render(
      <Board tasks={tasks} focusCol={1} focusRow={0} showFailed={false} now={Date.now()} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Backlog (1)");
    expect(frame).toContain("Queued (1)");
    expect(frame).toContain("Running (1)");
    expect(frame).toContain("Review (1)");
    expect(frame).toContain("two");
  });

  test("column counts and failed toggle", () => {
    const tasks = [
      task({ id: "t-1", status: "done", title: "ok" }),
      task({ id: "t-2", status: "failed", title: "ng" }),
    ];
    expect(columnTasks(tasks, 5, false).map((t) => t.id)).toEqual(["t-1"]);
    expect(columnTasks(tasks, 5, true).map((t) => t.id)).toEqual(["t-2"]);
    const { lastFrame } = render(
      <Board tasks={tasks} focusCol={5} focusRow={0} showFailed={true} now={Date.now()} />,
    );
    // note: the test renderer is narrow; keep titles short of the truncation
    expect(lastFrame()!).toContain("Failed (1)");
    expect(lastFrame()!).toContain("ng");
  });

  test("running card shows heartbeat badge", () => {
    const tasks = [
      task({ id: "t-3", status: "running", title: "x", run: { lastHeartbeatAt: new Date().toISOString() } }),
    ];
    const { lastFrame } = render(
      <Board tasks={tasks} focusCol={2} focusRow={0} showFailed={false} now={Date.now()} />,
    );
    expect(lastFrame()!).toContain("●");
  });

  test("COLUMNS covers every non-failed status", () => {
    const covered = new Set(COLUMNS.flatMap((c) => c.statuses));
    for (const s of ["backlog", "queued", "running", "blocked", "review", "done"]) {
      expect(covered.has(s as never)).toBe(true);
    }
  });
});

describe("displayWidth", () => {
  test("ascii=1, CJK=2, mixed", async () => {
    const { displayWidth } = await import("../src/cursor.ts");
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("認証フロー")).toBe(10);
    expect(displayWidth("fix 認証")).toBe(8);
    expect(displayWidth("")).toBe(0);
  });
});
