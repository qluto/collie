import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { teardownTask, type HerdrRequester, type Task } from "../src/index.ts";

const task = (over: Partial<Task>): Task => ({
  id: "t-20260808-aaaa",
  title: "A task",
  status: "done",
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

function recorder(fail?: string): HerdrRequester & { calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  return {
    calls,
    async request(method, params) {
      calls.push([method, params]);
      if (fail) throw new Error(fail);
      return {};
    },
  };
}

function cleanCheckout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collie-teardown-"));
  spawnSync("git", ["-C", dir, "init", "-q"]);
  return dir;
}

describe("teardownTask", () => {
  test("a clean worktree task is removed through worktree.remove, never pane.close", async () => {
    const herdr = recorder();
    const wt = cleanCheckout();
    const out = await teardownTask(
      task({ worktree: true, branch: "collie/x", run: { worktreePath: wt, workspaceId: "w1", paneId: "p1" } as Task["run"] }),
      herdr,
    );
    expect(herdr.calls).toEqual([["worktree.remove", { workspace_id: "w1" }]]);
    expect(out).toBe("worktree removed (branch collie/x kept)");
  });

  test("a dirty worktree is kept and nothing is sent to herdr", async () => {
    const herdr = recorder();
    const wt = cleanCheckout();
    fs.writeFileSync(path.join(wt, "wip.txt"), "x");
    const out = await teardownTask(
      task({ worktree: true, run: { worktreePath: wt, workspaceId: "w1", paneId: "p1" } as Task["run"] }),
      herdr,
    );
    expect(herdr.calls).toEqual([]);
    expect(out).toContain("kept the worktree: 1 uncommitted file(s)");
  });

  test("a worktree.remove failure is reported, not thrown", async () => {
    const out = await teardownTask(
      task({ worktree: true, run: { worktreePath: cleanCheckout(), workspaceId: "w1" } as Task["run"] }),
      recorder("busy"),
    );
    expect(out).toBe("worktree.remove failed: busy");
  });

  test("a non-worktree task has just its pane closed", async () => {
    const herdr = recorder();
    const out = await teardownTask(task({ run: { paneId: "p1" } as Task["run"] }), herdr);
    expect(herdr.calls).toEqual([["pane.close", { pane_id: "p1" }]]);
    expect(out).toBe("pane closed");
  });

  test("a herdr failure is reported, not thrown", async () => {
    const out = await teardownTask(task({ run: { paneId: "p1" } as Task["run"] }), recorder("gone"));
    expect(out).toBe("pane.close failed: gone");
  });

  test("a task with no pane has nothing to close", async () => {
    expect(await teardownTask(task({}), recorder())).toBe("nothing to close");
  });
});
