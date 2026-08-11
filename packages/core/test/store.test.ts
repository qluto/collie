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
  createTask, deleteTask, getTask, listArchived, listTasks, transition, updateTask, cancelTask,
  markDone, parseTaskFile, retryTask, serializeTask, tailEvents, IllegalTransitionError,
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
    expect(got!.status).toBe("queued"); // tossed in = will run
    expect(got!.queuedAt).toBeDefined();
    expect(got!.size).toBe("S");
    expect(got!.priority).toBe(5);
    expect(got!.prompt).toBe("Do the thing.\n\nWith **markdown**.\n");
    expect(got!.rev).toBe(0);
    expect(got!.branch).toBe(`collie/${t.id}`);
  });

  test("markDone: review -> done, running routes through review, idempotent", () => {
    const reviewed = createTask({ title: "a", repo: "/tmp", prompt: "p" });
    transition(reviewed.id, "running");
    transition(reviewed.id, "review", { resultSummary: "did it" });
    expect(markDone(reviewed.id).status).toBe("done");
    // a second keypress must not throw
    expect(markDone(reviewed.id).status).toBe("done");

    // the human at the pane knows the session is finished even if it never
    // called back: running -> review -> done in one step
    const running = createTask({ title: "b", repo: "/tmp", prompt: "p" });
    transition(running.id, "running");
    expect(markDone(running.id).status).toBe("done");
    expect(tailEvents(10, running.id).map((e) => e.to)).toEqual(["queued", "running", "review", "done"]);
  });

  test("markDone refuses tasks that were never dispatched", () => {
    const queued = createTask({ title: "c", repo: "/tmp", prompt: "p" });
    expect(() => markDone(queued.id)).toThrow(/is queued/);
  });

  test("retryTask restores a full attempt budget", () => {
    const t = createTask({ title: "a", repo: "/tmp", prompt: "p" });
    updateTask(t.id, (task) => {
      task.attempts = task.maxAttempts;
    });
    transition(t.id, "failed", { failureReason: "boom" }, { source: "test" });
    const next = retryTask(t.id, { source: "test" });
    expect(next.status).toBe("queued");
    expect(next.attempts).toBe(0);
  });

  const legacyFile = (extra: string) => `---
id: t-20260101-aaaa
title: legacy
status: backlog
repo: /tmp
priority: 100
size: M
${extra}worktree: false
permissionMode: acceptEdits
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
attempts: 0
maxAttempts: 2
rev: 0
---
body`;

  test("a pre-refocus backlog file parses as queued", () => {
    expect(parseTaskFile(legacyFile(""), "mem").status).toBe("queued");
  });

  test("a leftover defer: line never survives the next write", () => {
    const parsed = parseTaskFile(legacyFile("defer: true\n"), "mem");
    expect((parsed as unknown as Record<string, unknown>).defer).toBeUndefined();
    expect(serializeTask(parsed)).not.toContain("defer:");

    // and on disk: one updateTask is enough to drop it
    fs.mkdirSync(path.join(process.env.COLLIE_HOME!, "tasks"), { recursive: true });
    fs.writeFileSync(path.join(process.env.COLLIE_HOME!, "tasks", "t-20260101-aaaa.md"),
      legacyFile("defer: true\n"));
    updateTask("t-20260101-aaaa", (t) => {
      t.priority = 1;
    });
    const raw = fs.readFileSync(
      path.join(process.env.COLLIE_HOME!, "tasks", "t-20260101-aaaa.md"), "utf8");
    expect(raw).not.toContain("defer:");
    expect(raw).toContain("status: queued");
  });

  test("serialize/parse round-trip with run sub-object", () => {
    const t = createTask({ title: "x", repo: "/tmp", prompt: "body" });
    const started = transition(t.id, "running", { paneId: "w1:p2", sessionId: "abc" }, { source: "test" });
    const reparsed = parseTaskFile(serializeTask(started), "mem");
    expect(reparsed.run?.paneId).toBe("w1:p2");
    expect(reparsed.run?.sessionId).toBe("abc");
    expect(reparsed.status).toBe("running");
  });

  test("run.question persists, and an explicit undefined patch clears it", () => {
    const t = createTask({ title: "q", repo: "/tmp", prompt: "p" });
    transition(t.id, "running", undefined, { source: "test" });
    transition(t.id, "blocked", { question: "Which migration should I run?" }, { source: "test" });
    expect(getTask(t.id)!.run?.question).toBe("Which migration should I run?");

    transition(t.id, "running", { question: undefined, questionScrapedAt: undefined }, { source: "test" });
    expect(getTask(t.id)!.run?.question).toBeUndefined();
    // the key must be gone from the file, not serialized as null
    const raw = fs.readFileSync(path.join(process.env.COLLIE_HOME!, "tasks", `${t.id}.md`), "utf8");
    expect(raw).not.toContain("question:");
  });

  test("listTasks sorts by priority then queuedAt", () => {
    const a = createTask({ title: "a", repo: "/tmp", prompt: "p", priority: 200 });
    const b = createTask({ title: "b", repo: "/tmp", prompt: "p", priority: 10 });
    const c = createTask({ title: "c", repo: "/tmp", prompt: "p", priority: 10 });
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
    transition(t.id, "running", undefined, { source: "test" });
    const events = tailEvents(10, t.id);
    expect(events.length).toBe(2);
    expect(events[0]!.from).toBe(null);
    expect(events[0]!.to).toBe("queued");
    expect(events[1]!.from).toBe("queued");
    expect(events[1]!.to).toBe("running");
  });
});

describe("transitions", () => {
  test("legal path queued→running→review→done", () => {
    const t = createTask({ title: "x", repo: "/tmp", prompt: "p" });
    transition(t.id, "running");
    transition(t.id, "review", { resultSummary: "did it" });
    const done = transition(t.id, "done");
    expect(done.status).toBe("done");
    expect(done.endedAt).toBeDefined();
    expect(done.run?.resultSummary).toBe("did it");
  });

  test("illegal transitions throw", () => {
    const t = createTask({ title: "x", repo: "/tmp", prompt: "p" });
    expect(() => transition(t.id, "done")).toThrow(IllegalTransitionError);
    expect(() => transition(t.id, "review")).toThrow(IllegalTransitionError);
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

  test("cancel semantics: a queued task is deleted, a live one is failed", () => {
    const q = createTask({ title: "q", repo: "/tmp", prompt: "p" });
    cancelTask(q.id);
    expect(getTask(q.id)).toBeNull();
    const r = createTask({ title: "r", repo: "/tmp", prompt: "p" });
    transition(r.id, "running");
    const cancelled = cancelTask(r.id);
    expect(cancelled.status).toBe("failed");
    expect(cancelled.run?.failureReason).toBe("cancelled");
  });

  test("deleteTask removes the file and journals it", () => {
    const t = createTask({ title: "oops", repo: "/tmp", prompt: "p" });
    deleteTask(t.id, { source: "test" });
    expect(fs.existsSync(path.join(process.env.COLLIE_HOME!, "tasks", `${t.id}.md`))).toBe(false);
    expect(getTask(t.id)).toBeNull();
    expect(listTasks().map((x) => x.id)).not.toContain(t.id);
    const last = tailEvents(10, t.id).at(-1)!;
    expect(last.from).toBe("queued");
    expect(last.to).toBe("deleted");
    expect(() => deleteTask(t.id)).toThrow(/no such task/);
  });
});

describe("archiving", () => {
  const livePath = (id: string) => path.join(process.env.COLLIE_HOME!, "tasks", `${id}.md`);
  const archivedPath = (id: string) => path.join(process.env.COLLIE_HOME!, "tasks", "archive", `${id}.md`);

  test("done moves the task out of the working set but keeps it readable", () => {
    const t = createTask({ title: "x", repo: "/tmp", prompt: "p" });
    transition(t.id, "running");
    transition(t.id, "review", { resultSummary: "did it" });
    transition(t.id, "done");

    expect(fs.existsSync(livePath(t.id))).toBe(false);
    expect(fs.existsSync(archivedPath(t.id))).toBe(true);
    // the archived file is the FINAL content, not the pre-transition one
    expect(fs.readFileSync(archivedPath(t.id), "utf8")).toContain("status: done");

    expect(listTasks().map((x) => x.id)).not.toContain(t.id);
    expect(listTasks({ includeArchived: true }).map((x) => x.id)).toContain(t.id);
    expect(getTask(t.id)!.status).toBe("done");
  });

  test("done -> review walks the task back out of the archive", () => {
    const t = createTask({ title: "x", repo: "/tmp", prompt: "p" });
    transition(t.id, "running");
    transition(t.id, "review");
    transition(t.id, "done");

    const back = transition(t.id, "review", undefined, { source: "tui" });
    expect(back.status).toBe("review");
    expect(fs.existsSync(livePath(t.id))).toBe(true);
    // both copies would list the task twice and archive it back on the next done
    expect(fs.existsSync(archivedPath(t.id))).toBe(false);
    expect(listTasks().map((x) => x.id)).toContain(t.id);
    expect(listTasks({ includeArchived: true }).filter((x) => x.id === t.id).length).toBe(1);
  });

  test("a half-migrated home lists the task once, from the live file", () => {
    const t = createTask({ title: "z", repo: "/tmp", prompt: "p" });
    transition(t.id, "running");
    transition(t.id, "review");
    transition(t.id, "done");
    // pre-upgrade leftover: the same task still sitting in the working set
    fs.copyFileSync(archivedPath(t.id), livePath(t.id));
    const listed = listTasks({ includeArchived: true }).filter((x) => x.id === t.id);
    expect(listed.length).toBe(1);
  });

  test("listArchived: newest first, bounded, and a count that ignores the bound", async () => {
    const ids: string[] = [];
    for (const title of ["first", "second", "third"]) {
      const t = createTask({ title, repo: "/tmp", prompt: "p" });
      transition(t.id, "running");
      transition(t.id, "review", { resultSummary: `${title} summary` });
      transition(t.id, "done");
      ids.push(t.id);
      await Bun.sleep(2); // endedAt is the sort key; keep the stamps distinct
    }

    // folded: the count only, no file parsed
    expect(listArchived(0)).toEqual({ tasks: [], total: 3 });

    const two = listArchived(2);
    expect(two.total).toBe(3);
    expect(two.tasks.map((t) => t.id)).toEqual([ids[2]!, ids[1]!]);
    expect(two.tasks[0]!.run?.resultSummary).toBe("third summary");

    expect(listArchived(50).tasks.map((t) => t.id)).toEqual([...ids].reverse());
  });

  test("listArchived on a home that has never archived anything", () => {
    createTask({ title: "live", repo: "/tmp", prompt: "p" });
    expect(listArchived(10)).toEqual({ tasks: [], total: 0 });
  });

  test("markDone stays idempotent across the archive move", () => {
    const t = createTask({ title: "y", repo: "/tmp", prompt: "p" });
    transition(t.id, "running");
    expect(markDone(t.id).status).toBe("done");
    expect(markDone(t.id).status).toBe("done"); // reads the archived file
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
