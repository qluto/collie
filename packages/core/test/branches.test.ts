import { describe, expect, test, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { discardTaskWork, droppedTasks, readBranchScan, refreshBranchScan } from "../src/branches.ts";
import { headCommit } from "../src/git.ts";
import { createTask, getTask, listTasks, transition } from "../src/store.ts";

let repo: string;

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return (res.stdout ?? "").trim();
}

function commit(cwd: string, file: string, body: string): void {
  fs.writeFileSync(path.join(cwd, file), body);
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", `add ${file}`);
}

/**
 * A task sitting in review with its own worktree branch. `commits` decides
 * whether the agent actually produced anything; `recordBase` mimics a task
 * dispatched before run.baseCommit existed.
 */
function reviewTask(opts?: { commits?: boolean; recordBase?: boolean }): string {
  const task = createTask({ title: "t", repo, prompt: "p", worktree: true });
  const wt = `${repo}-wt-${task.id}`;
  git(repo, "worktree", "add", "-q", "-b", `collie/${task.id}`, wt);
  const base = headCommit(wt)!;
  if (opts?.commits !== false) commit(wt, `${task.id}.txt`, "work\n");
  transition(task.id, "running", {
    worktreePath: wt,
    ...(opts?.recordBase === false ? {} : { baseCommit: base }),
  });
  transition(task.id, "review");
  return task.id;
}

/** Take the branch the way a human does: fast-forward it into the checkout. */
function merge(id: string): void {
  git(repo, "merge", "--ff-only", `collie/${id}`);
}

beforeEach(() => {
  process.env.COLLIE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "collie-branches-home-"));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "collie-branches-repo-"));
  git(repo, "init", "-q", "-b", "main");
  commit(repo, "README.md", "hi\n");
});

describe("branch scan", () => {
  test("a merged review task is adoptable; an unmerged one is left alone", () => {
    const merged = reviewTask();
    const pending = reviewTask();
    merge(merged);

    const scan = refreshBranchScan({ maxAgeSec: 0 });
    expect(scan.adoptable).toEqual([merged]);
    expect(scan.dropped).toEqual([]);
    expect(scan.repos).toEqual([repo]);
    expect(pending).toBeTruthy();
  });

  test("a branch that never got a commit is not adoptable", () => {
    // It is contained in HEAD from birth, so "merged" says nothing about it —
    // an agent that finished with an uncommitted plan must still reach a human.
    const empty = reviewTask({ commits: false });
    const scan = refreshBranchScan({ maxAgeSec: 0 });
    expect(scan.adoptable).toEqual([]);
    expect(getTask(empty)!.status).toBe("review");
  });

  test("a task dispatched before baseCommit existed falls back to the reflog", () => {
    // The oldest reflog entry is the branch's birth commit — the same value
    // baseCommit would hold, and still readable after the merge.
    const legacy = reviewTask({ recordBase: false });
    merge(legacy);
    expect(refreshBranchScan({ maxAgeSec: 0 }).adoptable).toEqual([legacy]);
  });

  test("the reflog fallback keeps the empty-branch guard", () => {
    const legacyEmpty = reviewTask({ commits: false, recordBase: false });
    expect(refreshBranchScan({ maxAgeSec: 0 }).adoptable).toEqual([]);
    expect(getTask(legacyEmpty)!.status).toBe("review");
  });

  test("no baseCommit and no reflog means don't know, so don't touch it", () => {
    const id = reviewTask({ recordBase: false });
    merge(id);
    fs.rmSync(path.join(repo, ".git", "logs", "refs", "heads", "collie", `${id}`), { force: true });
    expect(refreshBranchScan({ maxAgeSec: 0 }).adoptable).toEqual([]);
  });

  test("done with an unmerged branch is dropped; merging it later takes it back", () => {
    const id = reviewTask();
    transition(id, "done"); // the human said done without taking the work
    expect(refreshBranchScan({ maxAgeSec: 0 }).dropped).toEqual([id]);
    expect(droppedTasks({ maxAgeSec: 0 }).map((t) => t.id)).toEqual([id]);

    merge(id);
    expect(refreshBranchScan({ maxAgeSec: 0 }).dropped).toEqual([]);
  });

  test("a live task's unmerged branch is not dropped", () => {
    const id = reviewTask();
    expect(refreshBranchScan({ maxAgeSec: 0 }).dropped).toEqual([]);
    expect(listTasks({ status: ["review"] }).map((t) => t.id)).toEqual([id]);
  });

  test("discardTaskWork takes the worktree with the branch", () => {
    const id = reviewTask();
    transition(id, "done");
    expect(refreshBranchScan({ maxAgeSec: 0 }).dropped).toEqual([id]);
    const wt = `${repo}-wt-${id}`;
    fs.writeFileSync(path.join(wt, "scratch.log"), "residue\n"); // untracked goes too

    // git refuses to delete a branch a checkout still holds, so the order is
    // the feature: worktree, prune, then branch.
    expect(discardTaskWork(getTask(id)!)).toEqual({ ok: true, message: `discarded collie/${id}` });
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(repo, "branch", "--list", `collie/${id}`)).toBe("");

    const scan = refreshBranchScan({ maxAgeSec: 0 });
    expect(scan.dropped).toEqual([]);
    expect(scan.repos).toEqual([]); // nothing left to ask this repo about
  });

  test("discardTaskWork refuses to throw away uncommitted work", () => {
    const id = reviewTask();
    transition(id, "done");
    const wt = `${repo}-wt-${id}`;
    fs.writeFileSync(path.join(wt, "README.md"), "edited by hand\n"); // tracked

    const res = discardTaskWork(getTask(id)!);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("1 uncommitted change(s)");
    expect(fs.existsSync(wt)).toBe(true);
    expect(git(repo, "branch", "--list", `collie/${id}`)).not.toBe("");
  });

  test("the roster carries a repo out of the working set", () => {
    // Steady state: the scan that ran while the task was live is what keeps the
    // repo reachable afterwards, so no later scan has to walk the archive.
    const id = reviewTask();
    expect(refreshBranchScan({ maxAgeSec: 0 }).repos).toEqual([repo]);
    transition(id, "done");
    expect(listTasks().length).toBe(0); // working set empty: only the roster knows
    expect(refreshBranchScan({ maxAgeSec: 0 }).dropped).toEqual([id]);
  });

  test("a cold start seeds the roster from the archive instead", () => {
    const id = reviewTask();
    transition(id, "done");
    expect(readBranchScan()).toBeNull(); // nothing ever scanned this machine
    expect(refreshBranchScan({ maxAgeSec: 0 }).dropped).toEqual([id]);
  });

  test("a fresh scan is reused inside its window and cached to disk", () => {
    const id = reviewTask();
    transition(id, "done");
    refreshBranchScan({ maxAgeSec: 0 });
    expect(readBranchScan()!.dropped).toEqual([id]);

    merge(id); // changing git does not change a scan that is still young
    expect(refreshBranchScan({ maxAgeSec: 300 }).dropped).toEqual([id]);
    expect(refreshBranchScan({ maxAgeSec: 0 }).dropped).toEqual([]);
  });

  test("a repo that has gone missing is skipped, not thrown", () => {
    const id = reviewTask();
    transition(id, "done");
    refreshBranchScan({ maxAgeSec: 0 });
    fs.rmSync(repo, { recursive: true, force: true });
    const scan = refreshBranchScan({ maxAgeSec: 0 });
    expect(scan.repos).toEqual([]);
    expect(scan.dropped).toEqual([]);
  });
});
