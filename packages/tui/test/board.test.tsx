import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Board, COLUMNS, columnTasks } from "../src/views/board.tsx";
import type { Task } from "@collie/core";

const task = (over: Partial<Task>): Task => ({
  id: "t-20260808-aaaa",
  title: "A task",
  status: "queued",
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
  test("renders all five columns with counts", () => {
    const tasks = [
      task({ id: "t-1", status: "queued", title: "one" }),
      task({ id: "t-2", status: "queued", title: "two" }),
      task({ id: "t-3", status: "running", title: "three", run: { lastHeartbeatAt: new Date().toISOString() } }),
      task({ id: "t-4", status: "blocked", title: "four" }),
      task({ id: "t-5", status: "review", title: "five" }),
    ];
    const { lastFrame } = render(
      <Board tasks={tasks} focusCol={0} focusRow={0} now={Date.now()} columns={100} />,
    );
    const frame = lastFrame()!;
    // unfocused headers are truncated to fit; the count is never dropped
    expect(frame).toContain("Queued 2"); // focused column keeps its full name
    expect(frame).toMatch(/Runni\S* 1/);
    expect(frame).toMatch(/Aski\S* 1/); // blocked reads as "Asking"
    expect(frame).toContain("two");
  });

  test("a done task has no lane; failed has its own", () => {
    const tasks = [
      task({ id: "t-1", status: "done", title: "ok" }),
      task({ id: "t-2", status: "failed", title: "ng" }),
    ];
    expect(COLUMNS.flatMap((c) => c.statuses)).not.toContain("done");
    expect(columnTasks(tasks, 4).map((t) => t.id)).toEqual(["t-2"]);
    const { lastFrame } = render(
      <Board tasks={tasks} focusCol={4} focusRow={0} now={Date.now()} columns={100} />,
    );
    // note: the test renderer is narrow; keep titles short of the truncation
    expect(lastFrame()!).toContain("Failed 1");
    expect(lastFrame()!).toContain("ng");
    expect(lastFrame()!).not.toContain("ok");
  });

  test("CJK titles never push a column border off its row", async () => {
    const { displayWidth } = await import("../src/cursor.ts");
    const tasks = [
      task({ id: "t-1", status: "queued", title: "プロンプトアシスタントバグ修正" }),
      task({ id: "t-2", status: "running", title: "認証フローのリファクタリング" }),
      task({ id: "t-3", status: "review", title: "日本語のとても長いタイトルが並んだとき" }),
    ];
    // check every column as the focused one: the wide card moves around
    for (let col = 0; col < COLUMNS.length; col++) {
      const { lastFrame } = render(
        <Board tasks={tasks} focusCol={col} focusRow={0} now={Date.now()} columns={100} />,
      );
      const rows = lastFrame()!
        .split("\n")
        .map((l) => displayWidth(l.replace(/\[[0-9;]*m/g, "")));
      expect(new Set(rows).size).toBe(1); // all rows are the same width -> borders line up
      expect(rows[0]).toBeLessThanOrEqual(100);
    }
  });

  test("the focused column is wide enough for a real title", () => {
    const title = "プロンプトアシスタントバグ修正";
    const { lastFrame } = render(
      <Board tasks={[task({ id: "t-1", status: "queued", title })]}
        focusCol={0} focusRow={0} now={Date.now()} columns={100} />,
    );
    expect(lastFrame()!).toContain(title); // in full, not truncated
  });

  test("running card shows heartbeat badge", () => {
    const tasks = [
      task({ id: "t-3", status: "running", title: "x", run: { lastHeartbeatAt: new Date().toISOString() } }),
    ];
    const { lastFrame } = render(
      <Board tasks={tasks} focusCol={1} focusRow={0} now={Date.now()} columns={100} />,
    );
    expect(lastFrame()!).toContain("●");
  });

  test("card meta is priority/size/repo — no eligibility marker", () => {
    const { lastFrame } = render(
      <Board tasks={[task({ id: "t-5", status: "queued", title: "x" })]}
        focusCol={0} focusRow={0} now={Date.now()} columns={100} />,
    );
    expect(lastFrame()!).toContain("p100 M repo");
    expect(lastFrame()!).not.toContain("☾");
  });

  test("a narrow terminal stacks the lanes vertically", async () => {
    const { displayWidth } = await import("../src/cursor.ts");
    const tasks = [
      task({ id: "q1", status: "queued", title: "プロンプトアシスタントバグ修正" }),
      task({ id: "r1", status: "running", title: "認証フローのリファクタリング" }),
    ];
    const { lastFrame } = render(
      <Board tasks={tasks} focusCol={0} focusRow={0} now={Date.now()} columns={44} rows={20} />,
    );
    const frame = lastFrame()!;
    expect(frame).not.toContain("╭"); // no side-by-side boxes
    expect(frame).toContain("▸ Queued 1"); // focused lane marked
    expect(frame).toContain("Running 1");
    expect(frame).toContain("プロンプトアシスタントバグ修正"); // full title, not truncated to 6 cells
    // empty lanes collapse away entirely instead of eating rows
    expect(frame).not.toContain("Asking");
    for (const line of frame.split("\n")) {
      expect(displayWidth(line.replace(/\[[0-9;]*m/g, ""))).toBeLessThanOrEqual(44);
    }
  });

  test("stacked layout never renders more rows than it was given", async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      task({ id: `t${i}`, status: (["blocked", "queued", "running", "review"] as const)[i % 4], title: `task ${i}` }),
    );
    for (const rows of [6, 8, 12, 20]) {
      const { lastFrame } = render(
        <Board tasks={many} focusCol={0} focusRow={2} now={Date.now()} columns={44} rows={rows} />,
      );
      const frame = lastFrame()!;
      expect(frame.split("\n").length).toBeLessThanOrEqual(rows);
      // whatever is dropped is stated, never silently missing
      if (rows <= 8) expect(frame).toMatch(/…/);
    }
  });

  test("the selected card stays visible when a lane is trimmed", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      task({ id: `q${i}`, status: "queued", title: `queued task ${i}` }),
    );
    const { lastFrame } = render(
      <Board tasks={many} focusCol={0} focusRow={9} now={Date.now()} columns={44} rows={8} />,
    );
    expect(lastFrame()!).toContain("queued task 9");
  });

  test("COLUMNS covers every live status (done is archived, not a lane)", () => {
    const covered = new Set(COLUMNS.flatMap((c) => c.statuses));
    for (const s of ["queued", "running", "blocked", "review", "failed"]) {
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
