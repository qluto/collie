import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createTask, getTask, transition } from "@collie/core";
import { runTaskCommand } from "../src/commands/task.ts";

const REPO = fs.mkdtempSync(path.join(os.tmpdir(), "collie-complete-repo-"));
spawnSync("git", ["init", "-q"], { cwd: REPO });

/** A herdr stand-in that records the frames it is sent. */
function fakeHerdr(): { socketPath: string; stop: () => void; frames: Array<Record<string, any>> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collie-herdr-"));
  const socketPath = path.join(dir, "herdr.sock");
  const frames: Array<Record<string, any>> = [];
  const server = Bun.listen({
    unix: socketPath,
    socket: {
      data(socket, chunk) {
        for (const line of chunk.toString().split("\n")) {
          if (line.trim().length === 0) continue;
          const req = JSON.parse(line);
          frames.push(req);
          socket.write(`${JSON.stringify({ id: req.id, result: { type: "ok" } })}\n`);
        }
      },
    },
  });
  return { socketPath, stop: () => server.stop(true), frames };
}

/** COLLIE_HOME whose config points herdr at `socketPath` (or nowhere). */
function freshHome(socketPath: string): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collie-complete-"));
  process.env.COLLIE_HOME = dir;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.toml"), `[herdr]\nsocket_path = "${socketPath}"\n`);
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
  delete process.env.COLLIE_GH_BIN;
});

function runningTask(): string {
  const t = createTask({ title: "ship the thing", repo: REPO, prompt: "p" });
  transition(t.id, "running", { paneId: "w1:p1" }, { source: "test" });
  return t.id;
}

describe("task complete", () => {
  test("reports the review status and the pull request to the sidebar", async () => {
    const srv = fakeHerdr();
    cleanup.push(srv.stop);
    freshHome(srv.socketPath);
    // gh answers with a PR, so $pr is set on the same transition
    const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), "collie-gh-"));
    const gh = path.join(ghDir, "gh");
    fs.writeFileSync(gh, `#!/bin/sh\necho '[{"number":77,"url":"https://github.com/o/r/pull/77"}]'\n`);
    fs.chmodSync(gh, 0o755);
    process.env.COLLIE_GH_BIN = gh;

    const id = runningTask();
    expect(await runTaskCommand(["complete", id, "--summary", "done it"])).toBe(0);

    expect(getTask(id)!.status).toBe("review");
    expect(getTask(id)!.run?.prNumber).toBe(77);
    const report = srv.frames.find((f) => f.method === "pane.report_metadata");
    expect(report).toBeDefined();
    expect(report!.params).toEqual({
      pane_id: "w1:p1",
      source: "collie",
      title: "ship the thing",
      tokens: { task: "ship the thing", status: "✅ review", pr: "#77" },
      seq: 1,
    });
  });

  test("an absent herdr socket does not change the exit code", async () => {
    freshHome("/nonexistent/herdr.sock");
    process.env.COLLIE_GH_BIN = "/nonexistent/gh";
    const id = runningTask();
    expect(await runTaskCommand(["complete", id, "--summary", "done it"])).toBe(0);
    expect(getTask(id)!.status).toBe("review");
  });

  test("a task with no pane reports nothing and still completes", async () => {
    const srv = fakeHerdr();
    cleanup.push(srv.stop);
    freshHome(srv.socketPath);
    process.env.COLLIE_GH_BIN = "/nonexistent/gh";
    const t = createTask({ title: "no pane", repo: REPO, prompt: "p" });
    transition(t.id, "running", undefined, { source: "test" });
    expect(await runTaskCommand(["complete", t.id, "--summary", "s"])).toBe(0);
    expect(srv.frames).toHaveLength(0);
  });
});
