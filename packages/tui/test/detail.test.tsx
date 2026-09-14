import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Detail } from "../src/views/detail.tsx";
import type { Task } from "@collie/core";

const task = (over: Partial<Task>): Task => ({
  id: "t-20260911-aaaa",
  title: "A task",
  status: "review",
  repo: "/tmp/repo",
  priority: 100,
  size: "M",
  worktree: true,
  branch: "collie/t-20260911-aaaa",
  permissionMode: "auto",
  claudeArgs: [],
  createdAt: "2026-09-11T00:00:00Z",
  updatedAt: "2026-09-11T00:00:00Z",
  attempts: 0,
  maxAttempts: 2,
  rev: 0,
  prompt: "p",
  ...over,
});

describe("Detail pr row", () => {
  test("renders #N as a clickable OSC 8 link to the pull request", () => {
    const url = "https://github.com/o/r/pull/12";
    const { lastFrame } = render(
      <Detail task={task({ run: { prNumber: 12, prUrl: url } })} columns={100} rows={40} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("pr");
    expect(frame).toContain(`\x1b]8;;${url}\x1b\\`);
    expect(frame).toContain("#12");
  });

  test("no pull request, no row", () => {
    const { lastFrame } = render(<Detail task={task({})} columns={100} rows={40} />);
    expect(lastFrame() ?? "").not.toContain("#12");
  });
});
