import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { listTasks } from "../src/store.ts";
import { announceStart, readLinearState, syncLinear } from "../src/linear/sync.ts";
import type { Config } from "../src/types.ts";

/** createTask refuses a path that is not a checkout, so the fixture is one. */
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), "collie-linear-repo-"));
spawnSync("git", ["init", "-q"], { cwd: REPO });

/** Never the real ~/.collie: syncLinear creates task files. */
function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collie-linear-"));
  process.env.COLLIE_HOME = dir;
  return dir;
}

interface Call {
  op: string;
  variables: Record<string, unknown>;
}

/**
 * A fake Linear over a real socket — the same shape the herdr client tests
 * use. It answers the three operations by name so a query the code did not
 * mean to send shows up as an unknown-op failure rather than a silent {}.
 */
function fakeLinear(opts: { issues: any[]; states?: unknown[]; fail?: string }) {
  const calls: Call[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { query: string; variables: Record<string, unknown> };
      const op = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "";
      calls.push({ op, variables: body.variables });
      if (opts.fail) return Response.json({ errors: [{ message: opts.fail }] });
      if (op === "CollieIssues") return Response.json({ data: { issues: { nodes: opts.issues } } });
      if (op === "CollieIssue") {
        const hit = opts.issues.find((i: any) => i.id === body.variables.id) ?? null;
        return Response.json({ data: { issue: hit } });
      }
      if (op === "CollieStates") {
        return Response.json({ data: { team: { states: { nodes: opts.states ?? [] } } } });
      }
      if (op === "CollieStart") return Response.json({ data: { issueUpdate: { success: true } } });
      if (op === "CollieComment") return Response.json({ data: { commentCreate: { success: true } } });
      return Response.json({ errors: [{ message: `unknown op ${op}` }] });
    },
  });
  process.env.COLLIE_LINEAR_API_URL = `http://localhost:${server.port}/graphql`;
  return { calls, stop: () => server.stop(true) };
}

const issue = (over: Record<string, unknown> = {}) => ({
  id: "iss_1",
  identifier: "ENG-42",
  title: "flaky テストを直す",
  description: "たまに落ちる",
  url: "https://linear.app/acme/issue/ENG-42",
  priority: 2,
  team: { id: "team_1", key: "ENG" },
  state: { id: "st_todo", name: "Todo", type: "unstarted" },
  ...over,
});

const STATES = [
  { id: "st_todo", name: "Todo", type: "unstarted", position: 0 },
  { id: "st_prog", name: "In Progress", type: "started", position: 1 },
];

function config(over: Partial<Config["linear"]> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    linear: { ...DEFAULT_CONFIG.linear, enabled: true, repos: { ENG: REPO }, ...over },
  };
}

let home: string;
beforeEach(() => {
  home = freshHome();
  process.env.COLLIE_LINEAR_API_KEY = "lin_api_test";
});
afterEach(() => {
  delete process.env.COLLIE_LINEAR_API_URL;
  delete process.env.COLLIE_LINEAR_API_KEY;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("syncLinear", () => {
  // Importing means the issue reached the QUEUE, where it may sit all evening
  // behind presence or the quota gate. Moving it to "In Progress" then would
  // be the board telling a lie, so a poll only ever reads.
  test("an issue becomes a queued task carrying its origin, and Linear is not touched", async () => {
    const fake = fakeLinear({ issues: [issue()], states: STATES });
    try {
      const res = await syncLinear(config(), { force: true });
      expect(res.created).toHaveLength(1);
      expect(res.warnings).toEqual([]);

      const [task] = listTasks();
      expect(task!.status).toBe("queued");
      expect(task!.repo).toBe(REPO);
      expect(task!.priority).toBe(50); // Linear "high"
      expect(task!.origin).toEqual({
        kind: "linear", id: "iss_1", ref: "ENG-42",
        url: "https://linear.app/acme/issue/ENG-42",
      });
      expect(task!.prompt).toContain("Linear ENG-42");

      expect(fake.calls.map((c) => c.op)).toEqual(["CollieIssues"]);
    } finally {
      fake.stop();
    }
  });

  // The whole point of the ledger. Two polls of the same open issue must not
  // make two tasks, whatever Linear says about it in between.
  test("a second poll of the same issue imports nothing", async () => {
    const fake = fakeLinear({ issues: [issue()], states: STATES });
    try {
      await syncLinear(config(), { force: true });
      const res = await syncLinear(config(), { force: true });
      expect(res.created).toEqual([]);
      expect(listTasks()).toHaveLength(1);
      expect(readLinearState().imported["iss_1"]!.ref).toBe("ENG-42");
    } finally {
      fake.stop();
    }
  });

  // Someone else's API on someone else's clock: the 30s dispatch tick must not
  // become a 30s poll.
  test("inside the poll interval it does not call out at all", async () => {
    const fake = fakeLinear({ issues: [], states: STATES });
    try {
      await syncLinear(config(), { force: true });
      const before = fake.calls.length;
      const res = await syncLinear(config({ pollIntervalMin: 30 }));
      expect(res.skipped).toMatch(/next poll in \d+s/);
      expect(fake.calls.length).toBe(before);
    } finally {
      fake.stop();
    }
  });

  test("disabled and key-less are idle states, not errors", async () => {
    expect((await syncLinear(config({ enabled: false }))).skipped).toBe("disabled");
    delete process.env.COLLIE_LINEAR_API_KEY;
    const fake = fakeLinear({ issues: [] });
    try {
      // no key: the keychain has no collie-linear entry in CI or on a fresh mac
      const res = await syncLinear(config(), { force: true });
      expect(res.skipped === undefined || res.skipped.startsWith("no API key")).toBe(true);
    } finally {
      fake.stop();
    }
  });

  // The promise the capture form makes, kept on the unattended path too: a
  // repo that has moved is a reported skip now, not a task that only fails
  // when the dispatcher reaches for it at 2am.
  test("an issue whose mapped repo is gone is skipped, with the path in the reason", async () => {
    const fake = fakeLinear({ issues: [issue()], states: STATES });
    try {
      const res = await syncLinear(config({ repos: { ENG: "/nowhere/at/all" } }), { force: true });
      expect(res.created).toEqual([]);
      const entry = res.entries[0]!;
      expect(entry.action).toBe("skip");
      expect(entry.action === "skip" && entry.reason).toContain("/nowhere/at/all does not exist");
      expect(listTasks()).toEqual([]);
    } finally {
      fake.stop();
    }
  });

  test("a dry run reports the same plan and writes nothing", async () => {
    const fake = fakeLinear({ issues: [issue()], states: STATES });
    try {
      const res = await syncLinear(config(), { force: true, dryRun: true });
      expect(res.entries).toHaveLength(1);
      expect(res.entries[0]!.action).toBe("import");
      expect(res.created).toEqual([]);
      expect(listTasks()).toEqual([]);
      expect(readLinearState().imported).toEqual({});
      expect(fake.calls.map((c) => c.op)).toEqual(["CollieIssues"]);
    } finally {
      fake.stop();
    }
  });

  // An outage must not turn into a call every 30 seconds for the rest of the
  // night, so the clock advances even though the poll failed.
  test("an API error throws but still spends the poll interval", async () => {
    const fake = fakeLinear({ issues: [], fail: "authentication failed" });
    try {
      await expect(syncLinear(config(), { force: true })).rejects.toThrow(/authentication failed/);
      expect(readLinearState().lastSyncAt).toBeGreaterThan(0);
    } finally {
      fake.stop();
    }
  });
});

const ORIGIN = { kind: "linear", id: "iss_1", ref: "ENG-42", url: "u" } as const;

describe("announceStart", () => {
  // The state moves when work actually begins, not when it was collected — and
  // the issue is re-READ first, because the import snapshot is hours old by
  // then and someone may have moved it in the meantime.
  test("moves the issue and comments, from a fresh read", async () => {
    const fake = fakeLinear({ issues: [issue()], states: STATES });
    try {
      expect(await announceStart(config().linear, ORIGIN, "t-1", "collie/t-1")).toEqual([]);
      const ops = fake.calls.map((c) => c.op);
      expect(ops).toEqual(["CollieIssue", "CollieStates", "CollieStart", "CollieComment"]);
      expect(fake.calls.find((c) => c.op === "CollieStart")!.variables.stateId).toBe("st_prog");
      expect(fake.calls.find((c) => c.op === "CollieComment")!.variables.body)
        .toBe("Started by collie as `t-1` on `collie/t-1`.");
    } finally {
      fake.stop();
    }
  });

  // The session is already up by the time this runs: a tidy board is never
  // worth unmaking it, so every failure is a warning and none is a throw.
  test("no started state on the team is a warning, not a failure", async () => {
    const fake = fakeLinear({ issues: [issue()], states: [] });
    try {
      const warnings = await announceStart(config().linear, ORIGIN, "t-1");
      expect(warnings.join(" ")).toContain("no started state");
    } finally {
      fake.stop();
    }
  });

  test("an issue that has vanished says so instead of throwing", async () => {
    const fake = fakeLinear({ issues: [], states: STATES });
    try {
      expect((await announceStart(config().linear, ORIGIN, "t-1")).join(" "))
        .toContain("gone from Linear");
    } finally {
      fake.stop();
    }
  });

  test("a task with no Linear origin, and a disabled integration, call out at all", async () => {
    const fake = fakeLinear({ issues: [issue()], states: STATES });
    try {
      expect(await announceStart(config().linear, undefined, "t-1")).toEqual([]);
      expect(await announceStart(config({ enabled: false }).linear, ORIGIN, "t-1")).toEqual([]);
      expect(fake.calls).toEqual([]);
    } finally {
      fake.stop();
    }
  });

  test("comment = false moves the state and says nothing", async () => {
    const fake = fakeLinear({ issues: [issue()], states: STATES });
    try {
      await announceStart(config({ comment: false }).linear, ORIGIN, "t-1");
      expect(fake.calls.map((c) => c.op)).not.toContain("CollieComment");
    } finally {
      fake.stop();
    }
  });
});
