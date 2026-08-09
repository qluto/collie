import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_CONFIG, clearUsageCache, createTask, transition,
  type Config, type HerdrAgentInfo,
} from "@collie/core";
import { createCtx } from "../src/dispatcher/ctx.ts";
import { planTick } from "../src/dispatcher/gates.ts";

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collie-gates-"));
  process.env.COLLIE_HOME = dir;
  return dir;
}

/** Always-full window + unreadable ccusage => the quota gate allows (gate.ts). */
function config(dispatch: Partial<Config["dispatch"]>, presence?: Partial<Config["presence"]>): Config {
  return {
    ...DEFAULT_CONFIG,
    dispatch: { ...DEFAULT_CONFIG.dispatch, ...dispatch },
    schedule: { windows: [], defaultMode: "full" },
    presence: { ...DEFAULT_CONFIG.presence, ...presence },
  };
}

/**
 * Force the HID probe to answer "unavailable" (its non-mac path), so the
 * other-agents signal is the only presence input and whoever runs the suite
 * isn't a variable.
 */
function withoutHidProbe<T>(fn: () => T): T {
  const orig = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: orig, configurable: true });
  }
}

function workingAgent(paneId: string): HerdrAgentInfo {
  return {
    agent: paneId,
    agent_status: "working",
    cwd: "/tmp",
    pane_id: paneId,
    tab_id: "tab-1",
    workspace_id: "ws-1",
  };
}

function blockedTask(title: string): string {
  const t = createTask({ title, repo: "/tmp", prompt: "p" });
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
    const candidate = createTask({ title: "work", repo: "/tmp", prompt: "p" });

    const plan = planTick(createCtx(config({ wipLimit: 2, askingLimit: 3 }), false));
    expect(plan.task?.id).toBe(candidate.id);
  });

  test("running tasks still consume it", () => {
    const running = createTask({ title: "r", repo: "/tmp", prompt: "p" });
    transition(running.id, "running", undefined, { source: "test" });
    createTask({ title: "work", repo: "/tmp", prompt: "p" });

    const plan = planTick(createCtx(config({ wipLimit: 1, askingLimit: 3 }), false));
    expect(plan.task).toBeUndefined();
    expect(plan.decision).toMatch(/wip full/);
  });

  test("unanswered questions past asking_limit pause dispatch", () => {
    blockedTask("q1");
    createTask({ title: "work", repo: "/tmp", prompt: "p" });

    const plan = planTick(createCtx(config({ wipLimit: 2, askingLimit: 1 }), false));
    expect(plan.task).toBeUndefined();
    expect(plan.decision).toMatch(/asking limit/);
  });
});

describe("planTick presence", () => {
  test("someone else's working pane downgrades a full window", () => {
    createTask({ title: "work", repo: "/tmp", prompt: "p" });
    const ctx = createCtx(config({}, { enabled: true }), false);
    ctx.agents = [workingAgent("pane-someone-else")];

    const plan = withoutHidProbe(() => planTick(ctx));
    expect(plan.mode).toBe("conservative");
    expect(plan.decision).toMatch(/presence: another agent working → conservative/);
  });

  test("our own running task's pane is not 'someone else'", () => {
    const running = createTask({ title: "r", repo: "/tmp", prompt: "p" });
    transition(running.id, "running", { paneId: "pane-ours" }, { source: "test" });
    createTask({ title: "work", repo: "/tmp", prompt: "p" });
    const ctx = createCtx(config({}, { enabled: true }), false);
    ctx.agents = [workingAgent("pane-ours")];

    const plan = withoutHidProbe(() => planTick(ctx));
    expect(plan.mode).toBe("full");
    expect(plan.decision).not.toMatch(/presence/);
  });

  test("disabled presence never touches the mode", () => {
    createTask({ title: "work", repo: "/tmp", prompt: "p" });
    const ctx = createCtx(config({}), false);
    ctx.agents = [workingAgent("pane-someone-else")];

    const plan = planTick(ctx);
    expect(plan.mode).toBe("full");
    expect(plan.decision).not.toMatch(/presence/);
  });
});
