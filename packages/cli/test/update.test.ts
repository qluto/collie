import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createTask, transition, readUpdateCheck } from "@collie/core";
import { planUpdate, refuseUpdate, runUpdateCommand } from "../src/commands/update.ts";

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return (res.stdout ?? "").trim();
}

describe("refuseUpdate", () => {
  const ok = { trackedChanges: [], branch: "main", defaultBranch: "main", running: [], now: false };
  test("a clean default-branch checkout with nothing running may update", () => {
    expect(refuseUpdate(ok)).toBeNull();
  });
  test("tracked changes, another branch, an unknown default all refuse", () => {
    expect(refuseUpdate({ ...ok, trackedChanges: [" M x.ts"] })).toContain("uncommitted");
    expect(refuseUpdate({ ...ok, branch: "feat" })).toContain("feat");
    expect(refuseUpdate({ ...ok, branch: "HEAD" })).toContain("detached");
    expect(refuseUpdate({ ...ok, defaultBranch: null })).toContain("set-head");
  });
  test("running tasks refuse unless --now, and the reason says why it matters", () => {
    const r = refuseUpdate({ ...ok, running: ["t-1"] });
    expect(r).toContain("t-1");
    expect(r).toContain("hooks");
    expect(refuseUpdate({ ...ok, running: ["t-1"], now: true })).toBeNull();
  });
});

describe("planUpdate", () => {
  test("no tag, already contained, or a merge", () => {
    expect(planUpdate({ current: null, target: null, headContainsTarget: false }).action).toBe("none");
    expect(planUpdate({ current: "v0.2.0", target: "v0.2.0", headContainsTarget: true }).action).toBe("none");
    expect(planUpdate({ current: "v0.1.0", target: "v0.2.0", headContainsTarget: false }))
      .toEqual({ action: "merge", target: "v0.2.0" });
  });
});

describe("collie update against a sandbox origin", () => {
  let tmp: string;
  let work: string;
  let clone: string;
  let restarts: number;
  let installs: number;
  const saved = { home: process.env.COLLIE_HOME, root: process.env.COLLIE_INSTALL_ROOT };

  function release(tag: string, files: Record<string, string>, changelog?: string): void {
    for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(work, f), body);
    if (changelog) {
      const p = path.join(work, "CHANGELOG.md");
      const prev = fs.existsSync(p) ? fs.readFileSync(p, "utf8").replace("# Changelog\n\n", "") : "";
      fs.writeFileSync(p, `# Changelog\n\n${changelog}\n\n${prev}`);
    }
    git(work, "add", "-A");
    git(work, "commit", "-qm", tag);
    git(work, "tag", "-a", tag, "-m", tag);
    git(work, "push", "-q", "origin", "main", "--tags");
  }

  async function run(argv: string[], opts: { plist?: boolean } = {}): Promise<{ code: number; out: string }> {
    const lines: string[] = [];
    const [log, err] = [console.log, console.error];
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    console.error = (...a: unknown[]) => void lines.push(a.join(" "));
    const plistPath = path.join(tmp, opts.plist ? "present.plist" : "absent.plist");
    if (opts.plist) fs.writeFileSync(plistPath, "");
    try {
      const code = await runUpdateCommand(argv, {
        plistPath,
        restart: () => { restarts++; return 0; },
        install: () => { installs++; return 0; },
      });
      return { code, out: lines.join("\n") };
    } finally {
      console.log = log;
      console.error = err;
    }
  }

  beforeEach(() => {
    restarts = 0;
    installs = 0;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "collie-update-cmd-"));
    process.env.COLLIE_HOME = path.join(tmp, "home");
    const origin = path.join(tmp, "origin.git");
    work = path.join(tmp, "work");
    clone = path.join(tmp, "clone");
    spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    spawnSync("git", ["init", "-q", "-b", "main", work]);
    git(work, "remote", "add", "origin", origin);
    release("v0.1.0", { "bun.lock": "lock-1\n", "a.txt": "1\n" }, "## [0.1.0] - 2026-10-01\n- first");
    spawnSync("git", ["clone", "-q", origin, clone]);
    process.env.COLLIE_INSTALL_ROOT = clone;
  });

  afterEach(() => {
    process.env.COLLIE_HOME = saved.home;
    if (saved.root === undefined) delete process.env.COLLIE_INSTALL_ROOT;
    else process.env.COLLIE_INSTALL_ROOT = saved.root;
  });

  test("--check reports an available release without changing the checkout", async () => {
    release("v0.2.0", { "a.txt": "2\n" });
    const head = git(clone, "rev-parse", "HEAD");
    const r = await run(["--check"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("update available: v0.2.0");
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
  });

  test("already on the latest release says so", async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("already up to date");
  });

  test("fast-forwards to the newest release, prints its changelog and the config sections it lacks", async () => {
    release("v0.2.0", { "a.txt": "2\n" }, "## [0.2.0] - 2026-10-24\n- the update feature");
    release("v0.3.0-rc.1", { "a.txt": "rc\n" }); // a pre-release is never the target
    fs.mkdirSync(process.env.COLLIE_HOME!, { recursive: true });
    fs.writeFileSync(path.join(process.env.COLLIE_HOME!, "config.toml"), "[dispatch]\nwip_limit = 2\n");

    const r = await run([], { plist: true });
    expect(r.code).toBe(0);
    expect(git(clone, "describe", "--tags", "--exact-match")).toBe("v0.2.0");
    expect(r.out).toContain("v0.1.0");
    expect(r.out).toContain("→ v0.2.0");
    expect(r.out).toContain("- the update feature");
    expect(r.out).not.toContain("- first"); // (old, new] only
    expect(r.out).toContain("[update]");
    expect(installs).toBe(0); // bun.lock did not move
    expect(restarts).toBe(1);
    expect(readUpdateCheck()?.current).toBe("v0.2.0");
  });

  test("a moved bun.lock reinstalls; no plist means no restart", async () => {
    release("v0.2.0", { "bun.lock": "lock-2\n" });
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(installs).toBe(1);
    expect(restarts).toBe(0);
    expect(r.out).toContain("no launchd dispatcher");
  });

  test("refuses on tracked changes, another branch, running tasks — and changes nothing", async () => {
    release("v0.2.0", { "a.txt": "2\n" });
    const head = git(clone, "rev-parse", "HEAD");

    fs.writeFileSync(path.join(clone, "a.txt"), "local edit\n");
    expect((await run([])).out).toContain("uncommitted");
    git(clone, "checkout", "-q", "--", "a.txt");

    git(clone, "checkout", "-qb", "feature");
    expect((await run([])).out).toContain("feature");
    git(clone, "checkout", "-q", "main");

    const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
    git(repo, "init", "-q");
    const task = createTask({ title: "t", repo, prompt: "p", worktree: false });
    transition(task.id, "running");
    const busy = await run([]);
    expect(busy.code).toBe(1);
    expect(busy.out).toContain(task.id);
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);

    expect((await run(["--now"])).code).toBe(0);
    expect(git(clone, "describe", "--tags", "--exact-match")).toBe("v0.2.0");
  });

  test("refuses a checkout that cannot fast-forward, untouched", async () => {
    release("v0.2.0", { "a.txt": "2\n" });
    fs.writeFileSync(path.join(clone, "mine.txt"), "x\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "local commit");
    const head = git(clone, "rev-parse", "HEAD");
    const r = await run([]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("cannot fast-forward");
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
  });
});
