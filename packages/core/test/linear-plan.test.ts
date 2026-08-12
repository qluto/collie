import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  isUnstarted, issuePrompt, pickStartState, planImport, queuePriority,
} from "../src/linear/plan.ts";
import type { LinearIssue, LinearWorkflowState } from "../src/linear/api.ts";
import type { Config } from "../src/types.ts";

const issue = (over: Partial<LinearIssue> = {}): LinearIssue => ({
  id: "iss_1",
  identifier: "ENG-42",
  title: "flaky ログインテストを直す",
  description: "3回に1回落ちる",
  url: "https://linear.app/acme/issue/ENG-42",
  team: { id: "team_1", key: "ENG" },
  state: { id: "st_1", name: "Todo", type: "unstarted" },
  ...over,
});

const cfg = (over: Partial<Config["linear"]> = {}): Config["linear"] => ({
  ...DEFAULT_CONFIG.linear,
  enabled: true,
  repos: { ENG: "/repos/app" },
  ...over,
});

describe("queuePriority", () => {
  // Linear's 0 is "nobody said", which is not urgency — it belongs with the
  // normal ones, not at the head of the night.
  test("urgent leads, unset lands with normal", () => {
    expect(queuePriority(1)).toBeLessThan(queuePriority(2));
    expect(queuePriority(2)).toBeLessThan(queuePriority(3));
    expect(queuePriority(3)).toBeLessThan(queuePriority(4));
    expect(queuePriority(0)).toBe(queuePriority(3));
    expect(queuePriority(undefined)).toBe(queuePriority(3));
  });
});

describe("planImport", () => {
  test("a labelled, unstarted issue with a mapped team becomes a task", () => {
    const entry = planImport([issue()], cfg(), new Set())[0]!;
    expect(entry.action).toBe("import");
    if (entry.action !== "import") throw new Error("unreachable");
    expect(entry.repo).toBe("/repos/app");
    expect(entry.title).toBe("flaky ログインテストを直す");
    expect(entry.size).toBe("M");
    expect(entry.prompt).toContain("https://linear.app/acme/issue/ENG-42");
    expect(entry.prompt).toContain("3回に1回落ちる");
  });

  test("every reason an issue is passed over is reported, never silent", () => {
    const entries = planImport(
      [
        issue({ id: "a", identifier: "ENG-1" }),
        issue({ id: "b", identifier: "ENG-2", state: { id: "s", name: "In Progress", type: "started" } }),
        issue({ id: "c", identifier: "OPS-3", team: { id: "t2", key: "OPS" } }),
      ],
      cfg(),
      new Set(["a"]),
    );
    expect(entries.map((e) => e.action)).toEqual(["skip", "skip", "skip"]);
    expect(entries.map((e) => (e.action === "skip" ? e.reason : ""))).toEqual([
      "already imported",
      'state "In Progress" is already under way',
      "no repo mapped for team OPS",
    ]);
  });

  // collie moves an issue into a started state on import, so Linear's own board
  // is the second line of dedup: even with the local ledger gone, work already
  // picked up is not picked up again.
  test("a started state is what makes the write-back a dedup signal", () => {
    expect(isUnstarted({ type: "backlog" })).toBe(true);
    expect(isUnstarted({ type: "unstarted" })).toBe(true);
    expect(isUnstarted({ type: "triage" })).toBe(true);
    expect(isUnstarted({ type: "started" })).toBe(false);
    expect(isUnstarted({ type: "completed" })).toBe(false);
  });

  test("an empty title falls back to the identifier rather than making a blank card", () => {
    const entry = planImport([issue({ title: "   " })], cfg(), new Set())[0]!;
    expect(entry.action === "import" && entry.title).toBe("ENG-42");
  });

  test("a description-less issue still carries its reference", () => {
    expect(issuePrompt(issue({ description: null }))).toBe(
      "Linear ENG-42: https://linear.app/acme/issue/ENG-42\n",
    );
  });
});

describe("pickStartState", () => {
  const states: LinearWorkflowState[] = [
    { id: "s1", name: "Backlog", type: "backlog", position: 0 },
    { id: "s3", name: "In Review", type: "started", position: 2 },
    { id: "s2", name: "In Progress", type: "started", position: 1 },
  ];

  test("no config = the team's own first started state, whatever it is named", () => {
    expect(pickStartState(states, "")!.id).toBe("s2");
  });

  test("a configured name wins, case-insensitively", () => {
    expect(pickStartState(states, "in review")!.id).toBe("s3");
  });

  // Moving the issue somewhere arbitrary is worse than leaving it alone.
  test("a name that matches nothing means do not move it", () => {
    expect(pickStartState(states, "Doing")).toBeNull();
    expect(pickStartState([{ id: "s", name: "Todo", type: "unstarted", position: 0 }], "")).toBeNull();
  });
});
