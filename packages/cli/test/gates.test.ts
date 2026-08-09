import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, clearUsageCache, createTask, transition, type Config } from "@collie/core";
import { createCtx } from "../src/dispatcher/ctx.ts";
import { planTick } from "../src/dispatcher/gates.ts";

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collie-gates-"));
  process.env.COLLIE_HOME = dir;
  return dir;
}

/** Always-full window + unreadable ccusage => the quota gate allows (gate.ts). */
function config(dispatch: Partial<Config["dispatch"]>): Config {
  return {
    ...DEFAULT_CONFIG,
    dispatch: { ...DEFAULT_CONFIG.dispatch, ...dispatch },
    schedule: { windows: [], defaultMode: "full" },
  };
}

function blockedTask(title: string): string {
  const t = createTask({ title, repo: "/tmp", prompt: "p", status: "queued" });
  transition(t.id, "running", { paneId: `pane-${title}` }, { source: "test" });
  transition(t.id, "blocked", undefined, { source: "test" });
  return t.id;
}

beforeEach(() => {
  freshHome();
  process.env.COLLIE_CCUSAGE_BIN = "/nonexistent/ccusage";
  clearUsageCache();
});

afterAll(() => {
  delete process.env.COLLIE_CCUSAGE_BIN;
  clearUsageCache();
});

describe("planTick WIP accounting", () => {
  test("blocked tasks do not consume the WIP limit", () => {
    blockedTask("q1");
    blockedTask("q2");
    const candidate = createTask({ title: "work", repo: "/tmp", prompt: "p", status: "queued" });

    const plan = planTick(createCtx(config({ wipLimit: 2, askingLimit: 3 }), false));
    expect(plan.task?.id).toBe(candidate.id);
  });

  test("running tasks still consume it", () => {
    const running = createTask({ title: "r", repo: "/tmp", prompt: "p", status: "queued" });
    transition(running.id, "running", undefined, { source: "test" });
    createTask({ title: "work", repo: "/tmp", prompt: "p", status: "queued" });

    const plan = planTick(createCtx(config({ wipLimit: 1, askingLimit: 3 }), false));
    expect(plan.task).toBeUndefined();
    expect(plan.decision).toMatch(/wip full/);
  });

  test("unanswered questions past asking_limit pause dispatch", () => {
    blockedTask("q1");
    createTask({ title: "work", repo: "/tmp", prompt: "p", status: "queued" });

    const plan = planTick(createCtx(config({ wipLimit: 2, askingLimit: 1 }), false));
    expect(plan.task).toBeUndefined();
    expect(plan.decision).toMatch(/asking limit/);
  });
});
