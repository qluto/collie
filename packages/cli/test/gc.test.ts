import { describe, expect, test, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createTask, transition, updateTask } from "@collie/core";
import { runGcCommand } from "../src/commands/gc.ts";

let repo: string;

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return (res.stdout ?? "").trim();
}

function freshHome(): void {
  process.env.COLLIE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "collie-gc-home-"));
}

/** A finished worktree task, with its checkout already made. */
function finishedTask(opts?: { commit?: boolean }): { id: string; worktreePath: string } {
  const task = createTask({ title: "t", repo, prompt: "p", worktree: true });
  const worktreePath = `${repo}-wt-${task.id}`;
  git(repo, "worktree", "add", "-q", "-b", `collie/${task.id}`, worktreePath);
  if (opts?.commit) {
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
    git(worktreePath, "add", "-A");
    git(worktreePath, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "work");
  }
  transition(task.id, "running", { worktreePath });
  transition(task.id, "review");
  transition(task.id, "done");
  return { id: task.id, worktreePath };
}

function gc(...argv: string[]): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    expect(runGcCommand(argv)).toBe(0);
  } finally {
    console.log = orig;
  }
  return lines;
}

beforeEach(() => {
  freshHome();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "collie-gc-repo-"));
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
});

describe("collie gc", () => {
  test("collects a clean worktree and its merged branch", () => {
    const { id, worktreePath } = finishedTask();
    const lines = gc();
    expect(lines.join("\n")).toContain(`${id}  worktree removed; deleted merged branch collie/${id}`);
    expect(lines.at(-1)).toBe("1/1 cleaned");
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(git(repo, "branch", "--list", `collie/${id}`)).toBe("");
  });

  test("a task whose branch a human already merged and deleted never reappears", () => {
    // This is the ghost: gc used to read the vanished branch as "0 commits
    // ahead of HEAD" and report it as kept work on every run, forever.
    const { id, worktreePath } = finishedTask();
    git(repo, "worktree", "remove", worktreePath);
    git(repo, "branch", "-D", `collie/${id}`);

    const lines = gc();
    expect(lines.join("\n")).not.toContain(id);
    expect(lines.at(-1)).toBe("nothing to collect (1 finished task(s) already clean)");
  });

  test("a repo that no longer exists is not collectable, so it is not reported", () => {
    const { id } = finishedTask();
    fs.rmSync(repo, { recursive: true, force: true });
    const lines = gc();
    expect(lines.join("\n")).not.toContain(id);
  });

  test("an orphan checkout is still removed when its branch is gone", () => {
    const { id, worktreePath } = finishedTask();
    git(repo, "worktree", "remove", worktreePath); // re-add detached so the branch can go
    git(repo, "worktree", "add", "-q", "--detach", worktreePath);
    git(repo, "branch", "-D", `collie/${id}`);

    const lines = gc();
    expect(lines.join("\n")).toContain("worktree removed; branch collie/" + id + " was already gone");
    expect(fs.existsSync(worktreePath)).toBe(false);
  });

  test("untracked files hold the worktree until --force", () => {
    const { id, worktreePath } = finishedTask();
    fs.writeFileSync(path.join(worktreePath, "AGENTS.md"), "notes\n");

    expect(gc("--dry-run").join("\n")).toContain("kept worktree: 1 untracked file(s)");
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(git(repo, "branch", "--list", `collie/${id}`)).not.toBe(""); // held by the checkout

    expect(gc("--force").join("\n"))
      .toContain(`worktree removed (+1 untracked); deleted merged branch collie/${id}`);
    expect(fs.existsSync(worktreePath)).toBe(false);
  });

  test("--force never touches tracked changes", () => {
    const { id, worktreePath } = finishedTask();
    fs.writeFileSync(path.join(worktreePath, "README.md"), "edited\n");

    const lines = gc("--force");
    expect(lines.join("\n")).toContain("kept worktree: 1 uncommitted change(s)");
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(lines.at(-1)).toBe("0/1 cleaned");
    expect(id).toBeTruthy();
  });

  test("unmerged work is kept and counted honestly", () => {
    const { id } = finishedTask({ commit: true });
    const lines = gc();
    expect(lines.join("\n")).toContain(`kept collie/${id}: not merged (1 commit(s) ahead of HEAD)`);
    expect(git(repo, "branch", "--list", `collie/${id}`)).not.toBe("");
  });

  test("a checkout deleted by hand leaves no admin entry behind", () => {
    const { id, worktreePath } = finishedTask();
    fs.rmSync(worktreePath, { recursive: true });
    gc();
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(worktreePath);
    expect(git(repo, "branch", "--list", `collie/${id}`)).toBe(""); // merged, so it goes too
  });
});
