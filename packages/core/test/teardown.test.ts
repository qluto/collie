import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { linkedWorktreesByBranch, teardownTask, type HerdrRequester, type Task } from "../src/index.ts";

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

  describe("without a run record", () => {
    /** A repo with one linked checkout on `collie/x`, and what herdr says is open. */
    function lostRecord(workspaces: (wt: string) => unknown[]) {
      const repo = cleanCheckout();
      spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init", "--allow-empty"]);
      const wt = `${repo}-wt`;
      spawnSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "collie/x", wt]);
      const calls: [string, unknown][] = [];
      const herdr: HerdrRequester = {
        async request(method, params) {
          calls.push([method, params]);
          return method === "workspace.list" ? { workspaces: workspaces(wt) } : {};
        },
      };
      return { lost: task({ repo, worktree: true, branch: "collie/x" }), wt, calls, herdr };
    }
    const held = (wt: string) => [
      { workspace_id: "w0", worktree: { checkout_path: "/somewhere/else", is_linked_worktree: true } },
      { workspace_id: "w9", worktree: { checkout_path: wt, is_linked_worktree: true } },
    ];

    test("the checkout is found by its branch and the workspace by its checkout", async () => {
      const { lost, calls, herdr } = lostRecord(held);
      const out = await teardownTask(lost, herdr);
      expect(calls).toEqual([["workspace.list", undefined], ["worktree.remove", { workspace_id: "w9" }]]);
      expect(out).toBe("worktree removed (branch collie/x kept)");
    });

    test("a dirty checkout found this way is still kept", async () => {
      const { lost, wt, calls, herdr } = lostRecord(held);
      fs.writeFileSync(path.join(wt, "wip.txt"), "x");
      const out = await teardownTask(lost, herdr);
      expect(calls.map(([m]) => m)).not.toContain("worktree.remove");
      expect(out).toContain("kept the worktree: 1 uncommitted file(s)");
    });

    test("two workspaces on the checkout are not guessed between", async () => {
      const { lost, calls, herdr } = lostRecord((wt) => [
        ...held(wt),
        { workspace_id: "w10", worktree: { checkout_path: wt, is_linked_worktree: true } },
      ]);
      const out = await teardownTask(lost, herdr);
      expect(calls).toEqual([["workspace.list", undefined]]);
      expect(out).toBe("nothing to close");
    });

    test("a herdr that cannot list workspaces closes nothing", async () => {
      const { lost } = lostRecord(held);
      expect(await teardownTask(lost, recorder("gone"))).toBe("nothing to close");
    });

    test("with no workspace on the checkout there is nothing for herdr to close", async () => {
      const { lost, calls, herdr } = lostRecord(() => [{ workspace_id: "w0" }]);
      const out = await teardownTask(lost, herdr);
      expect(calls).toEqual([["workspace.list", undefined]]);
      expect(out).toBe("nothing to close");
    });
  });

  test("a recorded checkout with no recorded workspace falls back to its pane when herdr has no match", async () => {
    const herdr = recorder();
    const out = await teardownTask(
      task({ worktree: true, branch: "collie/x", run: { worktreePath: cleanCheckout(), paneId: "p1" } as Task["run"] }),
      herdr,
    );
    expect(herdr.calls).toEqual([["workspace.list", undefined], ["pane.close", { pane_id: "p1" }]]);
    expect(out).toBe("pane closed");
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

describe("linkedWorktreesByBranch", () => {
  function repoWithLinked(): { repo: string; wt: string } {
    const repo = cleanCheckout();
    spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init", "--allow-empty"]);
    const wt = `${repo}-wt with space`;
    spawnSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "collie/x", wt]);
    return { repo, wt };
  }

  test("maps a branch to the linked checkout that holds it", () => {
    const { repo, wt } = repoWithLinked();
    expect([...linkedWorktreesByBranch(repo)]).toEqual([["collie/x", fs.realpathSync(wt)]]);
  });

  test("the main checkout is left out even when it sits on a task branch", () => {
    const repo = cleanCheckout();
    spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init", "--allow-empty"]);
    spawnSync("git", ["-C", repo, "checkout", "-q", "-b", "collie/x"]);
    expect(linkedWorktreesByBranch(repo).size).toBe(0);
  });

  test("a detached checkout holds no branch", () => {
    const { repo, wt } = repoWithLinked();
    spawnSync("git", ["-C", wt, "checkout", "-q", "--detach"]);
    expect(linkedWorktreesByBranch(repo).size).toBe(0);
  });
});
