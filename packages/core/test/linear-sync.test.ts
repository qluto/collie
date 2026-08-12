import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { listTasks } from "../src/store.ts";
import { readLinearState, syncLinear } from "../src/linear/sync.ts";
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
function fakeLinear(opts: { issues: unknown[]; states?: unknown[]; fail?: string }) {
  const calls: Call[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { query: string; variables: Record<string, unknown> };
      const op = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "";
      calls.push({ op, variables: body.variables });
      if (opts.fail) return Response.json({ errors: [{ message: opts.fail }] });
      if (op === "CollieIssues") return Response.json({ data: { issues: { nodes: opts.issues } } });
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
  test("an issue becomes a queued task carrying its origin, and the issue is moved", async () => {
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

      const ops = fake.calls.map((c) => c.op);
      expect(ops).toContain("CollieStart");
      expect(ops).toContain("CollieComment");
      expect(fake.calls.find((c) => c.op === "CollieStart")!.variables.stateId).toBe("st_prog");
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

  // A task that exists is worth more than a tidy board: the write-back is
  // best-effort and its failure must not cost the import or the dedup record.
  test("a write-back failure keeps the task and reports a warning", async () => {
    const fake = fakeLinear({ issues: [issue()], states: [] }); // no started state to move to
    try {
      const res = await syncLinear(config(), { force: true });
      expect(res.created).toHaveLength(1);
      expect(res.warnings.join(" ")).toContain("no started state");
      expect(readLinearState().imported["iss_1"]).toBeDefined();
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
