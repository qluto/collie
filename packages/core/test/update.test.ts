import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  changelogSections, compareVersions, devReason, latestReleaseTag, parseVersion, readUpdateCheck,
  refreshUpdateCheck, updateAvailable, UPDATE_TTL_MS, type UpdateCheck,
} from "../src/update.ts";
import { decideDrift, installRoot, underLaunchd, DISPATCHER_LABEL } from "../src/install.ts";
import { DEFAULT_CONFIG, missingConfigSections, DEFAULT_CONFIG_TOML } from "../src/config.ts";

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return (res.stdout ?? "").trim();
}

const check = (over: Partial<UpdateCheck>): UpdateCheck => ({
  checkedAt: new Date().toISOString(), commit: "abc", current: "v0.2.0", latest: "v0.2.0", ...over,
});

describe("versions", () => {
  test("parse and order like semver, pre-releases before their release", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3, null]);
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3, null]);
    expect(parseVersion("v1.2")).toBeNull();
    expect(parseVersion("nightly")).toBeNull();
    expect(compareVersions("v0.10.0", "v0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0-rc.1", "v1.0.0")).toBeLessThan(0);
    expect(compareVersions("v1.0.0", "v1.0.0")).toBe(0);
  });

  test("latest release tag ignores pre-releases and non-version tags", () => {
    const out = [
      "a\trefs/tags/v0.2.0",
      "b\trefs/tags/v0.10.0",
      "c\trefs/tags/v0.11.0-rc.1",
      "d\trefs/tags/nightly",
      "e\trefs/tags/v0.9.0",
      "f\trefs/heads/v9.9.9",
    ].join("\n");
    expect(latestReleaseTag(out)).toBe("v0.10.0");
    expect(latestReleaseTag("")).toBeNull();
  });

  test("a notice only when origin is ahead, and an untagged checkout is behind any release", () => {
    expect(updateAvailable(check({ latest: "v0.3.0" }))).toBe("v0.3.0");
    expect(updateAvailable(check({ latest: "v0.2.0" }))).toBeNull();
    expect(updateAvailable(check({ current: "v0.4.0", latest: "v0.3.0" }))).toBeNull();
    expect(updateAvailable(check({ current: null, latest: "v0.1.0" }))).toBe("v0.1.0");
    expect(updateAvailable(check({ current: null, latest: null }))).toBeNull();
    expect(updateAvailable(null)).toBeNull();
  });

  test("a development checkout never gets a notice", () => {
    expect(updateAvailable(check({ latest: "v0.3.0", dev: "on feature, not main" }))).toBeNull();
    expect(devReason({ branch: "main", defaultBranch: "main", trackedChanges: 0 })).toBeUndefined();
    expect(devReason({ branch: "feat", defaultBranch: "main", trackedChanges: 0 })).toContain("feat");
    expect(devReason({ branch: "HEAD", defaultBranch: "main", trackedChanges: 0 })).toContain("detached");
    expect(devReason({ branch: "main", defaultBranch: "main", trackedChanges: 2 })).toContain("uncommitted");
    // origin/HEAD unset is "don't know", not "dev"
    expect(devReason({ branch: "feat", defaultBranch: null, trackedChanges: 0 })).toBeUndefined();
  });
});

describe("changelogSections", () => {
  const md = `# Changelog

## [Unreleased]
- next thing

## [0.4.0] - 2026-12-01
- four

## [0.3.0] - 2026-11-01
- three

## [0.2.0] - 2026-10-24
- two
`;
  test("returns what an update brought in: (from, to]", () => {
    const got = changelogSections(md, "v0.2.0", "v0.3.0");
    expect(got.map((s) => s.version)).toEqual(["0.3.0"]);
    expect(got[0]!.text).toContain("- three");
    expect(got[0]!.text).not.toContain("0.2.0");
  });
  test("from null = everything up to the target, Unreleased never", () => {
    expect(changelogSections(md, null, "v0.3.0").map((s) => s.version)).toEqual(["0.3.0", "0.2.0"]);
    expect(changelogSections(md, null, "v9.0.0").some((s) => s.version === "Unreleased")).toBe(false);
  });
});

describe("decideDrift", () => {
  const base = { bootCommit: "aaa", diskCommit: "bbb", previousDiskCommit: "aaa", underLaunchd: true };
  test("same code or unknown code: nothing", () => {
    expect(decideDrift({ ...base, diskCommit: "aaa" }).action).toBe("none");
    expect(decideDrift({ ...base, diskCommit: null }).action).toBe("none");
    expect(decideDrift({ ...base, bootCommit: null }).action).toBe("none");
  });
  test("the first tick that sees new code waits: a pull + install may be mid-way", () => {
    expect(decideDrift(base)).toEqual({ action: "wait", from: "aaa", to: "bbb" });
  });
  test("the same new HEAD two ticks running restarts the launchd job", () => {
    expect(decideDrift({ ...base, previousDiskCommit: "bbb" })).toEqual({ action: "restart", from: "aaa", to: "bbb" });
  });
  test("HEAD still moving keeps waiting", () => {
    expect(decideDrift({ ...base, diskCommit: "ccc", previousDiskCommit: "bbb" }).action).toBe("wait");
  });
  test("outside launchd nobody would bring it back: report only", () => {
    expect(decideDrift({ ...base, previousDiskCommit: "bbb", underLaunchd: false }).action).toBe("report");
  });
  test("launchd is recognised by its service name", () => {
    expect(underLaunchd({ XPC_SERVICE_NAME: DISPATCHER_LABEL })).toBe(true);
    expect(underLaunchd({ XPC_SERVICE_NAME: "0" })).toBe(false);
    expect(underLaunchd({})).toBe(false);
  });
});

describe("missingConfigSections", () => {
  test("the full template is missing nothing", () => {
    expect(missingConfigSections(DEFAULT_CONFIG_TOML)).toEqual([]);
  });
  test("names only the topmost missing table, and skips empty optional maps", () => {
    const old = `[dispatch]\nwip_limit = 2\n[quota]\nfraction_full = 0.8\n[linear]\nenabled = false\n`;
    const missing = missingConfigSections(old);
    expect(missing).toContain("update");
    expect(missing).toContain("schedule");
    expect(missing).not.toContain("schedule.windows"); // its parent is already named
    expect(missing).toContain("quota.burn_down");
    expect(missing).not.toContain("linear.repos");
    expect(missing).not.toContain("dispatch");
  });
  test("an unparseable file answers nothing (reported elsewhere)", () => {
    expect(missingConfigSections("[[[")).toEqual([]);
  });
});

describe("refreshUpdateCheck against a sandbox origin", () => {
  let tmp: string;
  let work: string;
  let clone: string;
  const saved = { home: process.env.COLLIE_HOME, root: process.env.COLLIE_INSTALL_ROOT };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "collie-update-"));
    process.env.COLLIE_HOME = path.join(tmp, "home");
    const origin = path.join(tmp, "origin.git");
    work = path.join(tmp, "work");
    clone = path.join(tmp, "clone");
    spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    spawnSync("git", ["init", "-q", "-b", "main", work]);
    fs.writeFileSync(path.join(work, "a.txt"), "1\n");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "one");
    git(work, "tag", "-a", "v0.1.0", "-m", "v0.1.0");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "main", "--tags");
    spawnSync("git", ["clone", "-q", origin, clone]);
    process.env.COLLIE_INSTALL_ROOT = clone;
  });

  afterEach(() => {
    process.env.COLLIE_HOME = saved.home;
    if (saved.root === undefined) delete process.env.COLLIE_INSTALL_ROOT;
    else process.env.COLLIE_INSTALL_ROOT = saved.root;
  });

  function release(tag: string): void {
    fs.appendFileSync(path.join(work, "a.txt"), `${tag}\n`);
    git(work, "commit", "-qam", tag);
    git(work, "tag", "-a", tag, "-m", tag);
    git(work, "push", "-q", "origin", "main", "--tags");
  }

  test("installRoot follows the override", () => {
    expect(installRoot()).toBe(clone);
  });

  test("sees a newer release without fetching anything", async () => {
    release("v0.2.0");
    const before = git(clone, "for-each-ref", "refs/tags");
    const c = await refreshUpdateCheck(DEFAULT_CONFIG);
    expect(c?.current).toBe("v0.1.0");
    expect(c?.latest).toBe("v0.2.0");
    expect(c?.error).toBeUndefined();
    expect(updateAvailable(c)).toBe("v0.2.0");
    // ls-remote is read-only: no tag arrived locally
    expect(git(clone, "for-each-ref", "refs/tags")).toBe(before);
    expect(readUpdateCheck()?.latest).toBe("v0.2.0");
  });

  test("throttled to once a day; force bypasses it", async () => {
    const now = Date.now();
    await refreshUpdateCheck(DEFAULT_CONFIG, { now });
    release("v0.2.0");
    expect((await refreshUpdateCheck(DEFAULT_CONFIG, { now: now + 60_000 }))?.latest).toBe("v0.1.0");
    expect((await refreshUpdateCheck(DEFAULT_CONFIG, { now: now + 60_000, force: true }))?.latest).toBe("v0.2.0");
  });

  test("a moved HEAD refreshes the local half between network checks", async () => {
    const now = Date.now();
    release("v0.2.0");
    await refreshUpdateCheck(DEFAULT_CONFIG, { now });
    git(clone, "pull", "-q", "--ff-only", "origin", "main");
    git(clone, "fetch", "-q", "--tags");
    const c = await refreshUpdateCheck(DEFAULT_CONFIG, { now: now + 60_000 });
    expect(c?.current).toBe("v0.2.0");
    expect(updateAvailable(c)).toBeNull();
  });

  test("an unreachable origin is a recorded error, and the clock still advances", async () => {
    const now = Date.now();
    await refreshUpdateCheck(DEFAULT_CONFIG, { now });
    git(clone, "remote", "set-url", "origin", path.join(tmp, "gone.git"));
    const failed = await refreshUpdateCheck(DEFAULT_CONFIG, { now: now + UPDATE_TTL_MS + 1 });
    expect(failed?.error).toContain("ls-remote");
    expect(failed?.latest).toBe("v0.1.0"); // the last known answer survives
    const again = await refreshUpdateCheck(DEFAULT_CONFIG, { now: now + UPDATE_TTL_MS + 60_000 });
    expect(again?.checkedAt).toBe(failed?.checkedAt); // no retry inside the day
  });

  test("a feature branch is a development checkout", async () => {
    release("v0.2.0");
    git(clone, "checkout", "-qb", "feature");
    const c = await refreshUpdateCheck(DEFAULT_CONFIG);
    expect(c?.dev).toContain("feature");
    expect(updateAvailable(c)).toBeNull();
  });

  test("switched off, nothing runs", async () => {
    const off = { ...DEFAULT_CONFIG, update: { check: false } };
    expect(await refreshUpdateCheck(off)).toBeNull();
    expect(readUpdateCheck()).toBeNull();
  });
});
