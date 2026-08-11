import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { AnswerForm, Harvest, harvestList } from "../src/views/harvest.tsx";
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
    expect(frame).toContain("✅ Review  2");
    expect(frame).toContain("❓ Asking  1");
    expect(frame).toContain("❌ Failed  1");
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

  test("groups are separated by a blank line when the harvest fits, never when it does not", () => {
    const tasks = [
      task({ id: "t-1", status: "review", title: "reviewed" }),
      task({ id: "t-2", status: "blocked", title: "asking", run: { question: "which?" } }),
      task({ id: "t-3", status: "failed", title: "broken", run: { failureReason: "spawn_timeout" } }),
    ];
    const roomy = render(
      <Harvest tasks={tasks} focusIdx={0} columns={80} rows={24} diffFor={noDiff} questionFor={noQuestion} />,
    ).lastFrame()!.split("\n");
    // one above each of the two later group headers, one above the footer
    expect(roomy.filter((l) => l.trim() === "").length).toBe(3);
    expect(roomy[0]!.trim()).not.toBe(""); // the view never opens on a blank row

    const tight = render(
      <Harvest tasks={tasks} focusIdx={0} columns={80} rows={9} diffFor={noDiff} questionFor={noQuestion} />,
    ).lastFrame()!.split("\n");
    expect(tight.filter((l) => l.trim() === "").length).toBe(0);
    expect(tight.length).toBeLessThanOrEqual(9);
  });

  test("folded, the archive is one line: a count and the key that opens it", () => {
    const { lastFrame } = render(
      <Harvest tasks={[task({ id: "t-1", status: "review", title: "live one" })]} focusIdx={0}
        columns={80} rows={24} diffFor={noDiff} questionFor={noQuestion}
        archived={[]} archivedTotal={42} archiveOpen={false} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("📦 Done  42 · A to open");
    expect(frame).toContain("live one");
  });

  test("dropped work sits between the failures and the archive, branch first", () => {
    const dropped = [
      task({ id: "x-1", status: "done", title: "tutorial rework", branch: "collie/x-1",
        endedAt: "2026-08-11T02:04:00Z", run: { resultSummary: "not taken" } }),
    ];
    const { lastFrame } = render(
      <Harvest tasks={[task({ id: "t-1", status: "failed", title: "broken one" })]} focusIdx={0}
        columns={80} rows={24} diffFor={() => "1 commit · 11 files +621 −175"}
        questionFor={noQuestion} dropped={dropped} archived={[]} archivedTotal={3} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("🗑 Dropped  1 · x discard · u reopen");
    expect(frame).toContain("tutorial rework");
    // the branch and its weight, because those are what `x` throws away
    expect(frame).toContain("collie/x-1 · 1 commit · 11 files +621 −175");
    expect(frame.indexOf("broken one")).toBeLessThan(frame.indexOf("tutorial rework"));
    expect(frame.indexOf("tutorial rework")).toBeLessThan(frame.indexOf("📦 Done"));
  });

  test("no dropped work, no dropped group", () => {
    const { lastFrame } = render(
      <Harvest tasks={[task({ id: "t-1", status: "review", title: "live one" })]} focusIdx={0}
        columns={80} rows={24} diffFor={noDiff} questionFor={noQuestion} dropped={[]} />,
    );
    expect(lastFrame()!).not.toContain("🗑");
  });

  test("an empty archive gets no line at all — even with nothing to harvest", () => {
    const { lastFrame } = render(
      <Harvest tasks={[]} focusIdx={0} columns={80} rows={24} diffFor={noDiff}
        questionFor={noQuestion} archived={[]} archivedTotal={0} archiveOpen={false} />,
    );
    expect(lastFrame()!).toContain("nothing to harvest");
    expect(lastFrame()!).not.toContain("📦");
  });

  test("open, the archive lists what was finished, with when and what came of it", () => {
    const archived = [
      task({ id: "d-1", status: "done", title: "ship the parser", endedAt: "2026-08-10T02:14:00Z",
        run: { resultSummary: "parser rewritten" } }),
      task({ id: "d-2", status: "done", title: "quota burn-down", endedAt: "2026-08-09T23:50:00Z" }),
    ];
    const { lastFrame } = render(
      <Harvest tasks={[]} focusIdx={0} columns={80} rows={24} diffFor={noDiff}
        questionFor={noQuestion} archived={archived} archivedTotal={7} archiveOpen />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("📦 Done  7 · A to close");
    expect(frame).not.toContain("A to open");
    expect(frame).toContain("ship the parser");
    expect(frame).toContain("parser rewritten");
    expect(frame).toContain("quota burn-down");
    // local-time stamp of endedAt, whatever the runner's zone
    const stamp = new Date("2026-08-10T02:14:00Z");
    const p = (n: number) => String(n).padStart(2, "0");
    expect(frame).toContain(
      `${p(stamp.getMonth() + 1)}-${p(stamp.getDate())} ${p(stamp.getHours())}:${p(stamp.getMinutes())}`,
    );
  });

  test("the open archive stays inside the row budget", () => {
    const archived = Array.from({ length: 20 }, (_, i) =>
      task({ id: `d${i}`, status: "done", title: `finished ${i}`,
        endedAt: "2026-08-10T02:14:00Z", run: { resultSummary: "summary" } }),
    );
    const live = Array.from({ length: 4 }, (_, i) =>
      task({ id: `r${i}`, status: "review", title: `review ${i}` }),
    );
    for (const rows of [24, 12, 6]) {
      const { lastFrame } = render(
        <Harvest tasks={live} focusIdx={0} columns={80} rows={rows} diffFor={noDiff}
          questionFor={noQuestion} archived={archived} archivedTotal={20} archiveOpen />,
      );
      expect(lastFrame()!.split("\n").length).toBeLessThanOrEqual(rows);
    }
  });

  test("the folded archive line does not push the last card off the screen", () => {
    const live = Array.from({ length: 12 }, (_, i) =>
      task({ id: `r${i}`, status: "review", title: `review ${i}` }),
    );
    for (const rows of [24, 10, 5]) {
      const { lastFrame } = render(
        <Harvest tasks={live} focusIdx={0} columns={80} rows={rows} diffFor={noDiff}
          questionFor={noQuestion} archived={[]} archivedTotal={9} archiveOpen={false} />,
      );
      const frame = lastFrame()!;
      expect(frame.split("\n").length).toBeLessThanOrEqual(rows);
      expect(frame).toContain("📦 Done  9 · A to open");
    }
  });

  test("footer names the one-key actions", () => {
    const { lastFrame } = render(
      <Harvest tasks={[task({ id: "t-1", status: "review" })]} focusIdx={0} columns={80} rows={24}
        diffFor={noDiff} questionFor={noQuestion} />,
    );
    expect(lastFrame()!)
      .toContain("d done · a answer · J jump · o resume · r retry · Enter detail · n new");
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

  test("dropped then archived are appended last, and only via their arguments", () => {
    const live = [task({ id: "r1", status: "review" }), task({ id: "f1", status: "failed" })];
    const archived = [task({ id: "d1", status: "done" }), task({ id: "d2", status: "done" })];
    const dropped = [task({ id: "x1", status: "done" })];
    expect(harvestList(live, { dropped, archived }).map((t) => t.id))
      .toEqual(["r1", "f1", "x1", "d1", "d2"]);
    // a done task that somehow sits in the working set still drops out
    expect(harvestList([...live, task({ id: "d3", status: "done" })]).map((t) => t.id))
      .toEqual(["r1", "f1"]);
  });
});
