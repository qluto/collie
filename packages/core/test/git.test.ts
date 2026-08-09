import { describe, expect, test, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  commitsAhead, deleteMergedBranch, diffSummary, dirtyFiles, mergedBranches, removeWorktree,
} from "../src/git.ts";

let repo: string;

function run(cwd: string, ...args: string[]): string {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return (res.stdout ?? "").trim();
}

function commit(cwd: string, file: string, body: string): void {
  fs.writeFileSync(path.join(cwd, file), body);
  run(cwd, "add", "-A");
  run(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", `add ${file}`);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "collie-git-"));
  run(repo, "init", "-q", "-b", "main");
  commit(repo, "README.md", "hi\n");
});

describe("git helpers", () => {
  test("mergedBranches only lists what HEAD already contains", () => {
    run(repo, "branch", "collie/merged");
    run(repo, "branch", "collie/ahead");
    // put a commit on one branch so it is no longer contained in HEAD
    const wt = path.join(repo, "..", path.basename(repo) + "-wt");
    run(repo, "worktree", "add", "-q", wt, "collie/ahead");
    commit(wt, "feature.txt", "work\n");

    const merged = mergedBranches(repo);
    expect(merged).toContain("collie/merged");
    expect(merged).not.toContain("collie/ahead");
    expect(commitsAhead(repo, "collie/ahead").length).toBe(1);

    removeWorktree(repo, wt);
    expect(fs.existsSync(wt)).toBe(false);
  });

  test("deleteMergedBranch refuses an unmerged branch and accepts a merged one", () => {
    run(repo, "branch", "collie/merged");
    run(repo, "branch", "collie/ahead");
    const wt = path.join(repo, "..", path.basename(repo) + "-wt2");
    run(repo, "worktree", "add", "-q", wt, "collie/ahead");
    commit(wt, "feature.txt", "work\n");
    removeWorktree(repo, wt);

    expect(deleteMergedBranch(repo, "collie/ahead").ok).toBe(false); // git branch -d is the safety net
    expect(deleteMergedBranch(repo, "collie/merged").ok).toBe(true);
    expect(run(repo, "branch", "--list", "collie/merged")).toBe("");
  });

  test("dirtyFiles sees uncommitted work and blocks nothing when clean", () => {
    expect(dirtyFiles(repo)).toEqual([]);
    fs.writeFileSync(path.join(repo, "scratch.txt"), "wip\n");
    expect(dirtyFiles(repo).length).toBe(1);
    expect(dirtyFiles(path.join(repo, "does-not-exist"))).toEqual([]);
  });

  test("diffSummary counts a worktree branch's own work", () => {
    const wt = path.join(repo, "..", path.basename(repo) + "-wt4");
    run(repo, "worktree", "add", "-q", "-b", "collie/work", wt);
    fs.writeFileSync(path.join(wt, "README.md"), "hi\nthere\n");
    commit(wt, "feature.txt", "one\ntwo\nthree\n");

    const summary = diffSummary(repo, "collie/work", wt)!;
    expect(summary).toContain("1 commit");
    expect(summary).toContain("2 files");
    expect(summary).toContain("+4"); // 3 added lines + 1 changed line in README
    expect(summary).toContain("−0");

    // a branch that vanished (worktree pruned, branch deleted) is not an error
    expect(diffSummary(repo, "collie/no-such-branch", wt)).toBeNull();
    expect(diffSummary(path.join(repo, "nope"), "collie/work", undefined)).toBeNull();
    removeWorktree(repo, wt);
  });

  test("diffSummary falls back to the dirty working tree without a branch", () => {
    expect(diffSummary(repo, undefined, undefined)).toBeNull(); // clean
    fs.writeFileSync(path.join(repo, "README.md"), "hi\nmore\n");
    fs.writeFileSync(path.join(repo, "untracked.txt"), "new\n");
    const summary = diffSummary(repo, undefined, undefined)!;
    expect(summary).toContain("2 dirty"); // untracked counts, unlike --shortstat
    expect(summary).toContain("1 file +1 −0");
  });

  test("removeWorktree refuses a dirty checkout", () => {
    const wt = path.join(repo, "..", path.basename(repo) + "-wt3");
    run(repo, "worktree", "add", "-q", "-b", "collie/dirty", wt);
    fs.writeFileSync(path.join(wt, "scratch.txt"), "uncommitted\n");
    expect(removeWorktree(repo, wt).ok).toBe(false);
    expect(fs.existsSync(wt)).toBe(true);
    fs.rmSync(path.join(wt, "scratch.txt"));
    expect(removeWorktree(repo, wt).ok).toBe(true);
  });
});
