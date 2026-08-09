import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { AnswerForm, Harvest, harvestList } from "../src/views/harvest.tsx";
import type { Task } from "@collie/core";

const task = (over: Partial<Task>): Task => ({
  id: "t-20260808-aaaa",
  title: "A task",
  status: "backlog",
  repo: "/tmp/repo",
  priority: 100,
  size: "M",
  defer: false,
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

const noDiff = () => null;
const noQuestion = () => null;

describe("Harvest", () => {
  test("groups review / asking / failed with counts and their evidence", () => {
    const tasks = [
      task({ id: "t-1", status: "review", title: "ship the parser", run: { resultSummary: "parser rewritten" } }),
      task({ id: "t-2", status: "review", title: "second review" }),
      task({ id: "t-3", status: "blocked", title: "waiting one", run: { question: "which migration?" } }),
      task({ id: "t-4", status: "failed", title: "broken one", attempts: 2, run: { failureReason: "spawn_timeout" } }),
      task({ id: "t-5", status: "running", title: "still going" }),
    ];
    const { lastFrame } = render(
      <Harvest tasks={tasks} focusIdx={0} columns={80} rows={24}
        diffFor={(t) => (t.id === "t-1" ? "2 commits · 3 files +120 −8" : null)} questionFor={noQuestion} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("✅ Review 2");
    expect(frame).toContain("❓ Asking 1");
    expect(frame).toContain("✗ Failed 1");
    expect(frame).toContain("parser rewritten");
    expect(frame).toContain("2 commits · 3 files +120 −8");
    expect(frame).toContain("which migration?");
    expect(frame).toContain("spawn_timeout · 2/2");
    expect(frame).not.toContain("still going"); // running is not harvest
  });

  test("a scraped pane wins over the hook's generic question", () => {
    const tasks = [
      task({
        id: "t-1", status: "blocked", title: "asking",
        run: { question: "Claude is waiting for your input", questionScrapedAt: "2026-08-08T02:00:00Z" },
      }),
    ];
    const { lastFrame } = render(
      <Harvest tasks={tasks} focusIdx={0} columns={80} rows={24} diffFor={noDiff}
        questionFor={() => "─────────\nShall I drop the legacy column?"} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Shall I drop the legacy column?");
    expect(frame).not.toContain("waiting for your input");
    expect(frame).not.toContain("─────────"); // box drawing from the scrape is dropped
  });

  test("the focused card is marked", () => {
    const tasks = [
      task({ id: "t-1", status: "review", title: "first" }),
      task({ id: "t-2", status: "review", title: "second" }),
    ];
    const { lastFrame } = render(
      <Harvest tasks={tasks} focusIdx={1} columns={80} rows={24} diffFor={noDiff} questionFor={noQuestion} />,
    );
    expect(lastFrame()!).toMatch(/▸ second/);
    expect(lastFrame()!).not.toMatch(/▸ first/);
  });

  test("never renders more rows than it was given, and says what it dropped", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      task({ id: `t${i}`, status: (["review", "blocked", "failed"] as const)[i % 3], title: `task ${i}`,
        run: { question: "why?", resultSummary: "done", failureReason: "idle_timeout" } }),
    );
    for (const rows of [12, 8, 20]) {
      const { lastFrame } = render(
        <Harvest tasks={many} focusIdx={0} columns={80} rows={rows}
          diffFor={() => "1 commit · 1 file +2 −0"} questionFor={noQuestion} />,
      );
      const frame = lastFrame()!;
      expect(frame.split("\n").length).toBeLessThanOrEqual(rows);
      expect(frame).toMatch(/… \+\d+ more/);
    }
  });

  test("the focused card stays visible past the row budget", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      task({ id: `t${i}`, status: "review", title: `task ${i}` }),
    );
    const { lastFrame } = render(
      <Harvest tasks={many} focusIdx={9} columns={80} rows={10} diffFor={noDiff} questionFor={noQuestion} />,
    );
    expect(lastFrame()!).toContain("task 9");
  });

  test("CJK never overflows the pane width", async () => {
    const { displayWidth } = await import("../src/cursor.ts");
    const tasks = [
      task({ id: "t-1", status: "review", title: "プロンプトアシスタントバグ修正のとても長いタイトル",
        run: { resultSummary: "認証フローのリファクタリングを完了しました、テストも通っています" } }),
      task({ id: "t-2", status: "blocked", title: "日本語のとても長いタイトルが並んだとき",
        run: { question: "このマイグレーションを実行してよいですか、それとも先にレビューが必要ですか" } }),
    ];
    const { lastFrame } = render(
      <Harvest tasks={tasks} focusIdx={0} columns={44} rows={20} diffFor={noDiff} questionFor={noQuestion} />,
    );
    for (const line of lastFrame()!.split("\n")) {
      expect(displayWidth(line.replace(/\[[0-9;]*m/g, ""))).toBeLessThanOrEqual(44);
    }
  });

  test("empty state", () => {
    const { lastFrame } = render(
      <Harvest tasks={[task({ status: "running" })]} focusIdx={0} columns={80} rows={24}
        diffFor={noDiff} questionFor={noQuestion} />,
    );
    expect(lastFrame()!).toContain("nothing to harvest");
  });

  test("footer names the one-key actions", () => {
    const { lastFrame } = render(
      <Harvest tasks={[task({ id: "t-1", status: "review" })]} focusIdx={0} columns={80} rows={24}
        diffFor={noDiff} questionFor={noQuestion} />,
    );
    expect(lastFrame()!).toContain("d done · a answer · J jump · r retry · Enter detail · n new");
  });
});

describe("AnswerForm", () => {
  // The input row is position-fixed (row 10) for IME preedit anchoring, so the
  // question block above it must always render the same number of lines.
  test("the question block is a fixed height whatever the question's length", () => {
    const heights = ["short?", "", "x ".repeat(400)].map((q) => {
      const { lastFrame, unmount } = render(
        <AnswerForm task={task({ id: "t-1", status: "blocked", title: "asking" })} question={q}
          columns={80} onSubmit={() => {}} onCancel={() => {}} />,
      );
      const lines = lastFrame()!.split("\n");
      unmount(); // hands the hardware cursor back; the input parks it while mounted
      return lines.findIndex((l) => l.includes("> ")) + 1; // 1-indexed row inside the box
    });
    expect(new Set(heights).size).toBe(1);
    expect(heights[0]).toBe(9); // + the app's own header row = screen row 10
  });
});

describe("harvestList", () => {
  test("orders review, then blocked, then failed; other statuses drop out", () => {
    const tasks = [
      task({ id: "f1", status: "failed" }),
      task({ id: "b1", status: "blocked" }),
      task({ id: "r1", status: "review" }),
      task({ id: "d1", status: "done" }),
      task({ id: "q1", status: "queued" }),
      task({ id: "r2", status: "review" }),
    ];
    expect(harvestList(tasks).map((t) => t.id)).toEqual(["r1", "r2", "b1", "f1"]);
    expect(harvestList([])).toEqual([]);
  });
});
