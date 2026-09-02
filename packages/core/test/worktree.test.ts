import { describe, expect, test, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";
import { runPostCreate, worktreeSettingsFor } from "../src/worktree.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "collie-wt-"));
});

describe("worktreeSettingsFor", () => {
  test("a repo with no override gets the top-level values", () => {
    expect(worktreeSettingsFor(DEFAULT_CONFIG, "/dev/projects/anything")).toEqual({
      base: "",
      fetch: true,
      postCreate: "",
      postCreateTimeoutSec: 60,
    });
  });

  test("an override is laid over the top-level values, key by key", () => {
    const config = parseConfig(
      `[worktree]\nbase = "main"\npost_create = "top"\n`
      + `[worktree.repos."/dev/projects/myapp"]\nbase = "develop"\n`,
    );
    expect(worktreeSettingsFor(config, "/dev/projects/myapp")).toEqual({
      base: "develop",
      fetch: true,
      postCreate: "top", // untouched keys still come from the top level
      postCreateTimeoutSec: 60,
    });
    expect(worktreeSettingsFor(config, "/dev/projects/other").base).toBe("main");
    // the same repo spelled differently is still that repo
    expect(worktreeSettingsFor(config, "/dev/projects/myapp/").base).toBe("develop");
    expect(worktreeSettingsFor(config, "/dev/projects/sub/../myapp").base).toBe("develop");
  });

  test("a symlinked checkout matches the override written against the real path", () => {
    const real = path.join(dir, "real");
    const link = path.join(dir, "link");
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    const config = parseConfig(`[worktree.repos."${real}"]\nbase = "develop"\n`);
    expect(worktreeSettingsFor(config, link).base).toBe("develop");
  });
});

describe("runPostCreate", () => {
  const logPath = (): string => path.join(dir, "runs", "t1", "post_create.log");

  test("runs the script in the worktree with the four env vars", async () => {
    const res = await runPostCreate({
      script: 'printf "%s\\n" "$COLLIE_REPO" "$COLLIE_WORKTREE" "$COLLIE_BRANCH" "$COLLIE_TASK_ID" > seen.txt; echo done',
      timeoutSec: 30,
      cwd: dir,
      env: {
        COLLIE_REPO: "/repo",
        COLLIE_WORKTREE: dir,
        COLLIE_BRANCH: "collie/t1",
        COLLIE_TASK_ID: "t1",
      },
      logPath: logPath(),
    });
    expect(res).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(dir, "seen.txt"), "utf8"))
      .toBe(`/repo\n${dir}\ncollie/t1\nt1\n`);
    expect(fs.readFileSync(logPath(), "utf8")).toContain("done");
  });

  test("a non-zero exit reports the code and the last stderr line", async () => {
    const res = await runPostCreate({
      script: 'echo "no .env to copy" >&2; exit 3',
      timeoutSec: 30,
      cwd: dir,
      env: {},
      logPath: logPath(),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("post_create exited 3: no .env to copy");
    expect(fs.readFileSync(logPath(), "utf8")).toContain("no .env to copy");
  });

  test("a script that hangs is killed and named as a timeout", async () => {
    const res = await runPostCreate({
      script: "sleep 5",
      timeoutSec: 1,
      cwd: dir,
      env: {},
      logPath: logPath(),
    });
    expect(res).toEqual({ ok: false, reason: "post_create timed out after 1s" });
  });

  test("an empty script spawns nothing and writes no log", async () => {
    expect(await runPostCreate({
      script: "   ",
      timeoutSec: 30,
      cwd: dir,
      env: {},
      logPath: logPath(),
    })).toEqual({ ok: true });
    expect(fs.existsSync(logPath())).toBe(false);
  });
});
