import { describe, expect, test, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collie-test-"));
  process.env.COLLIE_HOME = dir;
  return dir;
}

// Import lazily after COLLIE_HOME is set per-test (paths read env dynamically,
// so a single static import is fine as long as env is set before calls).
import {
  createTask, getTask, listTasks, transition, updateTask, cancelTask,
  parseTaskFile, serializeTask, tailEvents, IllegalTransitionError,
} from "../src/index.ts";

beforeEach(() => {
  freshHome();
});

describe("store basics", () => {
  test("create → get round-trip preserves fields and prompt", () => {
    const t = createTask({
      title: "Test task",
      repo: "/tmp/repo",
      prompt: "Do the thing.\n\nWith **markdown**.\n",
      size: "S",
      priority: 5,
    });
    const got = getTask(t.id);
    expect(got).not.toBeNull();
    expect(got!.title).toBe("Test task");
    expect(got!.status).toBe("backlog");
    expect(got!.size).toBe("S");
    expect(got!.priority).toBe(5);
    expect(got!.prompt).toBe("Do the thing.\n\nWith **markdown**.\n");
    expect(got!.rev).toBe(0);
    expect(got!.branch).toBe(`collie/${t.id}`);
  });

  test("serialize/parse round-trip with run sub-object", () => {
    const t = createTask({ title: "x", repo: "/tmp", prompt: "body" });
    const withRun = transition(t.id, "queued", undefined, { source: "test" });
    const started = transition(withRun.id, "running", { paneId: "w1:p2", sessionId: "abc" }, { source: "test" });
    const reparsed = parseTaskFile(serializeTask(started), "mem");
    expect(reparsed.run?.paneId).toBe("w1:p2");
    expect(reparsed.run?.sessionId).toBe("abc");
    expect(reparsed.status).toBe("running");
  });

  test("listTasks sorts by priority then queuedAt", () => {
    const a = createTask({ title: "a", repo: "/tmp", prompt: "p", priority: 200, status: "queued" });
    const b = createTask({ title: "b", repo: "/tmp", prompt: "p", priority: 10, status: "queued" });
    const c = createTask({ title: "c", repo: "/tmp", prompt: "p", priority: 10, status: "queued" });
    // same-priority order is by queuedAt; same-ms creation makes it ambiguous,
    // so set explicit timestamps
    updateTask(b.id, (t) => {
      t.queuedAt = "2026-08-08T00:00:01.000Z";
    });
    updateTask(c.id, (t) => {
      t.queuedAt = "2026-08-08T00:00:02.000Z";
    });
    const ids = listTasks({ status: ["queued"] }).map((t) => t.id);
    expect(ids[0]).toBe(b.id);
    expect(ids[1]).toBe(c.id);
    expect(ids[2]).toBe(a.id);
  });

  test("journal records transitions", () => {
    const t = createTask({ title: "j", repo: "/tmp", prompt: "p" });
    transition(t.id, "queued", undefined, { source: "test" });
    const events = tailEvents(10, t.id);
    expect(events.length).toBe(2);
    expect(events[1]!.from).toBe("backlog");
    expect(events[1]!.to).toBe("queued");
  });
});

describe("transitions", () => {
  test("legal path backlog→queued→running→review→done", () => {
    const t = createTask({ title: "x", repo: "/tmp", prompt: "p" });
    transition(t.id, "queued");
    transition(t.id, "running");
    transition(t.id, "review", { resultSummary: "did it" });
    const done = transition(t.id, "done");
    expect(done.status).toBe("done");
    expect(done.endedAt).toBeDefined();
    expect(done.run?.resultSummary).toBe("did it");
  });

  test("illegal transitions throw", () => {
    const t = createTask({ title: "x", repo: "/tmp", prompt: "p" });
    expect(() => transition(t.id, "running")).toThrow(IllegalTransitionError);
    expect(() => transition(t.id, "done")).toThrow(IllegalTransitionError);
    transition(t.id, "queued");
    transition(t.id, "running");
    expect(() => transition(t.id, "done")).toThrow(IllegalTransitionError);
  });

  test("updateTask refuses status change and bumps rev", () => {
    const t = createTask({ title: "x", repo: "/tmp", prompt: "p" });
    expect(() =>
      updateTask(t.id, (task) => {
        task.status = "done";
      }),
    ).toThrow();
    const u = updateTask(t.id, (task) => {
      task.priority = 1;
    });
    expect(u.rev).toBe(1);
    expect(u.priority).toBe(1);
  });

  test("cancel semantics", () => {
    const q = createTask({ title: "q", repo: "/tmp", prompt: "p", status: "queued" });
    expect(cancelTask(q.id).status).toBe("backlog");
    const r = createTask({ title: "r", repo: "/tmp", prompt: "p", status: "queued" });
    transition(r.id, "running");
    const cancelled = cancelTask(r.id);
    expect(cancelled.status).toBe("failed");
    expect(cancelled.run?.failureReason).toBe("cancelled");
  });
});

describe("concurrency", () => {
  test("two processes hammering updateTask: no lost updates, no torn files", async () => {
    const home = process.env.COLLIE_HOME!;
    const t = createTask({ title: "hammer", repo: "/tmp", prompt: "p" });
    const hammer = path.join(import.meta.dir, "hammer.ts");
    const N = 200;
    const run = (label: string) =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, [hammer, t.id, String(N), label], {
          env: { ...process.env, COLLIE_HOME: home },
          stdio: ["ignore", "inherit", "inherit"],
        });
        child.once("exit", (code) => (code === 0 ? resolve(0) : reject(new Error(`${label} exited ${code}`))));
        child.once("error", reject);
      });
    await Promise.all([run("A"), run("B")]);
    const final = getTask(t.id)!;
    expect(final.rev).toBe(2 * N);
    // both writers' counters fully applied
    const counters = final.run;
    expect(counters?.resultSummary).toContain(`A=${N}`);
    expect(counters?.resultSummary).toContain(`B=${N}`);
  }, 60_000);
});
