import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  assignedToMe, isUnstarted, issuePrompt, pickStartState, planImport, queuePriority, resolveRepo,
} from "../src/linear/plan.ts";
import type { LinearIssue, LinearWorkflowState } from "../src/linear/api.ts";
import type { Config } from "../src/types.ts";

const ME = "user_me";

const issue = (over: Partial<LinearIssue> = {}): LinearIssue => ({
  id: "iss_1",
  identifier: "ENG-42",
  title: "flaky ログインテストを直す",
  description: "3回に1回落ちる",
  url: "https://linear.app/acme/issue/ENG-42",
  team: { id: "team_1", key: "ENG" },
  state: { id: "st_1", name: "Todo", type: "unstarted" },
  assignee: { id: ME, displayName: "me" },
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
    const entry = planImport([issue()], cfg(), new Set(), [], undefined, ME)[0]!;
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
      [],
      undefined,
      ME,
    );
    expect(entries.map((e) => e.action)).toEqual(["skip", "skip", "skip"]);
    expect(entries.map((e) => (e.action === "skip" ? e.reason : ""))).toEqual([
      "already imported",
      'state "In Progress" is already under way',
      "no repo named OPS (repo/… label, project, team) — add it to [linear.repos] or rename to match a checkout",
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
    const entry = planImport([issue({ title: "   " })], cfg(), new Set(), [], undefined, ME)[0]!;
    expect(entry.action === "import" && entry.title).toBe("ENG-42");
  });

  test("a description-less issue still carries its reference", () => {
    expect(issuePrompt(issue({ description: null }))).toBe(
      "Linear ENG-42: https://linear.app/acme/issue/ENG-42\n",
    );
  });
});

describe("assignment", () => {
  // A whole team can share one board and one marker label; without this every
  // machine would race for every labelled issue.
  test("only issues assigned to the key's own user are collected", () => {
    const entries = planImport(
      [
        issue({ id: "a", identifier: "ENG-1" }),
        issue({ id: "b", identifier: "ENG-2", assignee: { id: "user_other", displayName: "Sam" } }),
        issue({ id: "c", identifier: "ENG-3", assignee: null }),
      ],
      cfg(),
      new Set(),
      [],
      undefined,
      ME,
    );
    expect(entries.map((e) => e.action)).toEqual(["import", "skip", "skip"]);
    expect(entries.slice(1).map((e) => (e.action === "skip" ? e.reason : ""))).toEqual([
      "assigned to Sam",
      "unassigned — assign it to yourself for collie to pick it up",
    ]);
  });

  // Filtered here rather than in the query, so the mistake everyone makes —
  // labelling an issue and forgetting to assign it — is a reported skip and
  // not an issue that silently never appears.
  test("assignee = any collects whatever carries the label", () => {
    const entries = planImport(
      [issue({ id: "b", assignee: { id: "user_other", displayName: "Sam" } }), issue({ id: "c", assignee: null })],
      cfg({ assignee: "any" }),
      new Set(),
      [],
      undefined,
      ME,
    );
    expect(entries.map((e) => e.action)).toEqual(["import", "import"]);
  });

  // Without a viewer id nothing can be proven to be mine, and guessing "yes"
  // would run a teammate's work.
  test("no viewer id means nothing is mine", () => {
    expect(assignedToMe(issue(), undefined)).toBe(false);
    const entry = planImport([issue()], cfg(), new Set(), [], undefined, undefined)[0]!;
    expect(entry.action).toBe("skip");
  });
});

describe("resolveRepo", () => {
  // One Linear workspace is not one repo, and often one TEAM is not either:
  // a single board can cover everything a person works on.
  const known = ["/dev/projects/collie", "/dev/projects/forge-neo-mobile"];

  test("a project named like its checkout needs no configuration at all", () => {
    const match = resolveRepo(
      issue({ project: { name: "forge-neo-mobile" } }),
      cfg({ repos: {} }),
      known,
    );
    expect(match).toEqual({ repo: "/dev/projects/forge-neo-mobile", via: "project forge-neo-mobile" });
  });

  test("the table is for when the two names disagree", () => {
    const match = resolveRepo(
      issue({ project: { name: "Mobile app" } }),
      cfg({ repos: { "Mobile app": "/dev/projects/forge-neo-mobile" } }),
      known,
    );
    expect(match!.repo).toBe("/dev/projects/forge-neo-mobile");
  });

  test("a repo: label beats the project, which beats the team", () => {
    const base = { project: { name: "forge-neo-mobile" } };
    expect(resolveRepo(issue(base), cfg({ repos: { ENG: "/dev/projects/collie" } }), known)!.via)
      .toBe("project forge-neo-mobile");
    expect(
      resolveRepo(
        issue({ ...base, labels: { nodes: [{ name: "collie" }, { name: "repo:collie" }] } }),
        cfg({ repos: {} }),
        known,
      ),
    ).toEqual({ repo: "/dev/projects/collie", via: "label collie" });
  });

  // How Linear actually reports a label group, live-probed: the child's own
  // name is the leaf and the group only appears in `parent`, so prefix-matching
  // the name can never see it.
  test("a label GROUP names the repo, with the group only in the parent", () => {
    const match = resolveRepo(
      issue({ labels: { nodes: [{ name: "collie", parent: { name: "repo" } }] } }),
      cfg({ repos: {} }),
      known,
    );
    expect(match).toEqual({ repo: "/dev/projects/collie", via: "label collie" });
  });

  test("a label that merely sits in another group is not a repo label", () => {
    const match = resolveRepo(
      issue({ labels: { nodes: [{ name: "collie", parent: { name: "area" } }] } }),
      cfg({ repos: { ENG: "/repos/app" } }),
      known,
    );
    expect(match!.via).toBe("team ENG");
  });

  test("a projectless issue still falls through to its team", () => {
    expect(resolveRepo(issue({ project: null }), cfg({ repos: { ENG: "/repos/app" } }), []))
      .toEqual({ repo: "/repos/app", via: "team ENG" });
  });

  // A typo in a label must not quietly ship the work to the team's default
  // repo — that is a wrong answer wearing a right answer's clothes.
  test("a repo: label that resolves to nothing stops the chain", () => {
    expect(
      resolveRepo(
        issue({ labels: { nodes: [{ name: "repo:typo" }] } }),
        cfg({ repos: { ENG: "/repos/app" } }),
        known,
      ),
    ).toBeNull();
  });

  // The asymmetry with the label case, pinned: a project is how the board is
  // organised, so an unmapped one falls through to the team's "everything else
  // goes here". A team entry is opt-in, and `via` keeps the fallback visible.
  test("an unmapped project falls through to the team, and says so", () => {
    const match = resolveRepo(
      issue({ project: { name: "Unknown Thing" } }),
      cfg({ repos: { ENG: "/repos/app" } }),
      known,
    );
    expect(match).toEqual({ repo: "/repos/app", via: "team ENG" });
    // …and with no team entry it is a reported skip, not a guess
    expect(resolveRepo(issue({ project: { name: "Unknown Thing" } }), cfg({ repos: {} }), known))
      .toBeNull();
  });

  test("an empty prefix turns the per-issue override off entirely", () => {
    const match = resolveRepo(
      issue({ labels: { nodes: [{ name: "repo:collie" }] } }),
      cfg({ repos: { ENG: "/repos/app" }, repoLabelPrefix: "" }),
      known,
    );
    expect(match!.via).toBe("team ENG");
  });

  test("names match case-insensitively, on the directory name only", () => {
    expect(resolveRepo(issue({ project: { name: "COLLIE" } }), cfg({ repos: {} }), known)!.repo)
      .toBe("/dev/projects/collie");
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
