import { describe, expect, test, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_CONFIG, createTask, findPullRequest, getTask, transition,
} from "@collie/core";
import { createCtx, type DispatcherCtx } from "../src/dispatcher/ctx.ts";
import { reportStatus } from "../src/dispatcher/dispatch.ts";
import { checkPullRequests } from "../src/dispatcher/pr.ts";

const REPO = fs.mkdtempSync(path.join(os.tmpdir(), "collie-pr-repo-"));
spawnSync("git", ["init", "-q"], { cwd: REPO });

function freshHome(): void {
  process.env.COLLIE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "collie-pr-"));
}

/** A gh stand-in: prints `out` on stdout and exits with `code`. */
function fakeGh(out: string, code = 0): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collie-gh-"));
  const bin = path.join(dir, "gh");
  fs.writeFileSync(bin, `#!/bin/sh\ncat <<'JSON'\n${out}\nJSON\nexit ${code}\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

/** ctx whose herdr requests are recorded instead of sent. */
function stubCtx(): { ctx: DispatcherCtx; sent: Array<{ method: string; params: unknown }> } {
  const ctx = createCtx(DEFAULT_CONFIG, false);
  const sent: Array<{ method: string; params: unknown }> = [];
  ctx.herdr = {
    request: async (method: string, params: unknown) => {
      sent.push({ method, params });
      return {};
    },
  } as unknown as DispatcherCtx["herdr"];
  return { ctx, sent };
}

describe("findPullRequest", () => {
  test("reads number and url out of gh's json", () => {
    process.env.COLLIE_GH_BIN = fakeGh('[{"number":1234,"url":"https://github.com/o/r/pull/1234"}]');
    expect(findPullRequest(REPO, "collie/x")).toEqual({
      number: 1234,
      url: "https://github.com/o/r/pull/1234",
    });
  });

  test("no pull request for the branch is null, not an error", () => {
    process.env.COLLIE_GH_BIN = fakeGh("[]");
    expect(findPullRequest(REPO, "collie/x")).toBeNull();
  });

  test("a failing or absent gh is null", () => {
    process.env.COLLIE_GH_BIN = fakeGh("not json", 1);
    expect(findPullRequest(REPO, "collie/x")).toBeNull();
    process.env.COLLIE_GH_BIN = "/nonexistent/gh";
    expect(findPullRequest(REPO, "collie/x")).toBeNull();
  });

  test("unparseable output is null", () => {
    process.env.COLLIE_GH_BIN = fakeGh("gh: not logged in");
    expect(findPullRequest(REPO, "collie/x")).toBeNull();
  });

  test("no branch means nothing to ask about", () => {
    process.env.COLLIE_GH_BIN = fakeGh('[{"number":7,"url":"u"}]');
    expect(findPullRequest(REPO, "")).toBeNull();
  });
});

describe("reportStatus", () => {
  beforeEach(freshHome);

  test("sends title plus the task/status/pr tokens", async () => {
    const { ctx, sent } = stubCtx();
    const t = createTask({ title: "wire the sidebar", repo: REPO, prompt: "p" });
    await reportStatus(ctx, t.id, "w1:p1", "▶ running");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("pane.report_metadata");
    expect(sent[0]!.params).toEqual({
      pane_id: "w1:p1",
      source: "collie",
      title: "wire the sidebar",
      tokens: { task: "wire the sidebar", status: "▶ running", pr: null },
      seq: 1,
    });
    // seq is persisted and strictly increasing, as herdr requires
    await reportStatus(ctx, t.id, "w1:p1", "⚠ needs review");
    expect((sent[1]!.params as { seq: number }).seq).toBe(2);
  });

  test("a known pull request rides along as $pr", async () => {
    const { ctx, sent } = stubCtx();
    const t = createTask({ title: "t", repo: REPO, prompt: "p" });
    transition(t.id, "running", { prNumber: 42 }, { source: "cli" });
    await reportStatus(ctx, t.id, "w1:p1", "▶ running");
    expect((sent[0]!.params as { tokens: Record<string, unknown> }).tokens.pr).toBe("#42");
  });
});

describe("checkPullRequests", () => {
  beforeEach(freshHome);

  test("records the pr, stamps the check, and re-reports the pane", async () => {
    process.env.COLLIE_GH_BIN = fakeGh('[{"number":9,"url":"https://github.com/o/r/pull/9"}]');
    const { ctx, sent } = stubCtx();
    const t = createTask({ title: "t", repo: REPO, prompt: "p" });
    transition(t.id, "running", { paneId: "w1:p1" }, { source: "cli" });
    await checkPullRequests(ctx);
    const after = getTask(t.id)!;
    expect(after.run?.prNumber).toBe(9);
    expect(after.run?.prUrl).toBe("https://github.com/o/r/pull/9");
    expect(after.run?.prCheckedAt).toBeTruthy();
    expect((sent.at(-1)!.params as { tokens: Record<string, unknown> }).tokens.pr).toBe("#9");
  });

  test("no pr found stamps the clock only, and is not asked again at once", async () => {
    process.env.COLLIE_GH_BIN = fakeGh("[]");
    const { ctx, sent } = stubCtx();
    const t = createTask({ title: "t", repo: REPO, prompt: "p" });
    transition(t.id, "running", { paneId: "w1:p1" }, { source: "cli" });
    await checkPullRequests(ctx);
    const first = getTask(t.id)!.run?.prCheckedAt;
    expect(first).toBeTruthy();
    expect(getTask(t.id)!.run?.prNumber).toBeUndefined();
    expect(sent).toHaveLength(0);

    await checkPullRequests(ctx);
    expect(getTask(t.id)!.run?.prCheckedAt).toBe(first);
  });

  test("a review task's row says review, not running", async () => {
    process.env.COLLIE_GH_BIN = fakeGh('[{"number":5,"url":"https://github.com/o/r/pull/5"}]');
    const { ctx, sent } = stubCtx();
    const t = createTask({ title: "t", repo: REPO, prompt: "p" });
    transition(t.id, "running", { paneId: "w1:p1" }, { source: "cli" });
    transition(t.id, "review", undefined, { source: "cli" });
    await checkPullRequests(ctx);
    expect((sent.at(-1)!.params as { tokens: Record<string, unknown> }).tokens.status).toBe("✅ review");
  });

  test("a task without a branch is never asked about", async () => {
    process.env.COLLIE_GH_BIN = fakeGh('[{"number":9,"url":"u"}]');
    const { ctx } = stubCtx();
    const t = createTask({ title: "t", repo: REPO, prompt: "p", worktree: false });
    transition(t.id, "running", undefined, { source: "cli" });
    expect(getTask(t.id)!.branch).toBeUndefined();
    await checkPullRequests(ctx);
    expect(getTask(t.id)!.run?.prCheckedAt).toBeUndefined();
  });
});
