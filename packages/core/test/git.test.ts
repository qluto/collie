import { describe, expect, test, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  branchState, commitsAhead, deleteMergedBranch, diffSummary, dirtyFiles, dirtyState, headCommit,
  defaultBranch, mergedBranches, pruneWorktrees, removeWorktree, resolveWorktreeBase,
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
    expect(commitsAhead(repo, "collie/ahead")!.length).toBe(1);

    removeWorktree(repo, wt);
    expect(fs.existsSync(wt)).toBe(false);
  });

  test("a vanished branch is null, not zero commits ahead", () => {
    // gc reads "0 ahead" as unmerged work it must keep; a branch a human already
    // merged and deleted has to be distinguishable from that.
    expect(commitsAhead(repo, "collie/never-existed")).toBeNull();
    run(repo, "branch", "collie/merged");
    expect(commitsAhead(repo, "collie/merged")).toEqual([]);
  });

  test("branchState answers existence and merge in one look", () => {
    run(repo, "branch", "collie/one");
    const state = branchState(repo);
    expect([...state.tips.keys()]).toEqual(expect.arrayContaining(["main", "collie/one"]));
    expect(state.tips.get("collie/one")).toBe(headCommit(repo)!); // tip, not a name
    expect(state.merged.has("collie/one")).toBe(true);

    run(repo, "branch", "-D", "collie/one");
    expect(branchState(repo).tips.has("collie/one")).toBe(false);
    expect(branchState(path.join(repo, "nope")).tips.size).toBe(0);
    expect(headCommit(path.join(repo, "nope"))).toBeNull();
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

  test("dirtyState separates work-at-risk from residue, and --force removes only residue", () => {
    const wt = path.join(repo, "..", path.basename(repo) + "-wt5");
    run(repo, "worktree", "add", "-q", "-b", "collie/residue", wt);
    fs.writeFileSync(path.join(wt, "AGENTS.md"), "notes\n");
    expect(dirtyState(wt)).toEqual({ tracked: [], untracked: ["?? AGENTS.md"] });

    fs.writeFileSync(path.join(wt, "README.md"), "edited\n");
    const both = dirtyState(wt);
    expect(both.tracked.length).toBe(1);
    expect(both.untracked.length).toBe(1);
    expect(dirtyFiles(wt).length).toBe(2);

    expect(removeWorktree(repo, wt, { force: true }).ok).toBe(true); // force takes both
    expect(fs.existsSync(wt)).toBe(false);
    expect(dirtyState(path.join(repo, "gone"))).toEqual({ tracked: [], untracked: [] });
  });

  test("pruneWorktrees forgets a checkout deleted by hand", () => {
    const wt = path.join(repo, "..", path.basename(repo) + "-wt6");
    run(repo, "worktree", "add", "-q", "-b", "collie/rmrf", wt);
    fs.rmSync(wt, { recursive: true });
    expect(run(repo, "worktree", "list", "--porcelain")).toContain(wt);
    expect(pruneWorktrees(repo).ok).toBe(true);
    expect(run(repo, "worktree", "list", "--porcelain")).not.toContain(wt);
  });
});

/**
 * A bare "origin" plus two clones: one is the machine collie dispatches from
 * (deliberately left behind), the other is the colleague who pushed while it
 * slept. That gap is the whole reason resolveWorktreeBase fetches.
 */
describe("resolveWorktreeBase", () => {
  let origin: string;
  let local: string;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collie-remote-"));
    origin = path.join(dir, "origin.git");
    fs.mkdirSync(origin);
    run(origin, "init", "-q", "--bare", "-b", "main");

    const seed = path.join(dir, "seed");
    run(dir, "clone", "-q", origin, seed);
    commit(seed, "README.md", "one\n");
    run(seed, "push", "-q", "origin", "main");

    local = path.join(dir, "local");
    run(dir, "clone", "-q", origin, local);
    run(local, "remote", "set-head", "origin", "-a");

    // the colleague's push, which `local` has never seen
    commit(seed, "later.txt", "two\n");
    run(seed, "push", "-q", "origin", "main");
  });

  test("fetch=true resolves origin/HEAD's branch at the remote's tip, not the stale local one", async () => {
    expect(defaultBranch(local)).toBe("main");
    const staleLocal = run(local, "rev-parse", "main");
    const remoteTip = run(origin, "rev-parse", "main");
    expect(staleLocal).not.toBe(remoteTip);

    const base = (await resolveWorktreeBase(local, { base: "", fetch: true }))!;
    // a sha, not "origin/main": a ref name would make the task branch TRACK it
    expect(base.ref).toBe(remoteTip);
    expect(base.note).toBe(`origin/main@${remoteTip.slice(0, 8)} (fetched)`);
    expect(run(local, "rev-parse", "origin/main")).toBe(remoteTip);
    expect(run(local, "rev-parse", "main")).toBe(staleLocal); // the local branch is untouched
  });

  test("fetch=false uses whatever was last fetched, and an explicit base wins over origin/HEAD", async () => {
    const before = run(local, "rev-parse", "origin/main");
    const base = (await resolveWorktreeBase(local, { base: "", fetch: false }))!;
    expect(base).toEqual({ ref: before, note: `origin/main@${before.slice(0, 8)} (not fetched)` });
    expect(run(local, "rev-parse", "origin/main")).toBe(before);

    run(local, "push", "-q", "origin", "main:develop");
    const explicit = (await resolveWorktreeBase(local, { base: "develop", fetch: true }))!;
    expect(explicit.ref).toBe(run(local, "rev-parse", "origin/develop"));
    expect(explicit.note).toStartWith("origin/develop@");
  });

  test("a broken remote falls back to the last fetched ref and says the fetch failed", async () => {
    run(local, "remote", "set-url", "origin", path.join(origin, "..", "gone.git"));
    const base = (await resolveWorktreeBase(local, { base: "", fetch: true }))!;
    expect(base.ref).toBe(run(local, "rev-parse", "origin/main"));
    expect(base.note).toStartWith("origin/main@");
    expect(base.note).toContain(" (fetch failed: ");
    expect(base.note).toEndWith(", using last fetched)");
  });

  test("no remote at all falls back to the local branch, and an unknown name is null", async () => {
    // `repo` is the plain init from the outer beforeEach: no origin, no origin/HEAD
    expect(defaultBranch(repo)).toBeNull();
    expect(await resolveWorktreeBase(repo, { base: "", fetch: true })).toBeNull();

    const base = (await resolveWorktreeBase(repo, { base: "main", fetch: true }))!;
    expect(base.ref).toBe(run(repo, "rev-parse", "main"));
    expect(base.note).toBe(`main@${base.ref.slice(0, 8)} (local, no origin)`);
    expect(await resolveWorktreeBase(repo, { base: "nope", fetch: true })).toBeNull();
  });
});
