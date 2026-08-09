import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { NewTaskForm, type NewTaskDraft } from "../src/views/newTask.tsx";

const REPOS = ["/tmp/repo-one", "/tmp/repo-two"];

const strip = (s: string) => s.replace(/\x1b?\[[0-9;]*m/g, "");
const lines = (frame: string) => strip(frame).split("\n");

/** one macrotask per keystroke: Ink parses stdin chunks asynchronously */
const tick = () => new Promise((r) => setTimeout(r, 10));

async function type(stdin: { write: (s: string) => void }, ...chunks: string[]): Promise<void> {
  for (const c of chunks) {
    stdin.write(c);
    await tick();
  }
}

/** repo (filter + Enter) then title (+ Enter) — leaves the form on the size step */
async function driveToSize(
  onSubmit: (d: NewTaskDraft) => void = () => {},
): Promise<ReturnType<typeof render>> {
  const app = render(<NewTaskForm knownRepos={REPOS} onSubmit={onSubmit} onCancel={() => {}} />);
  await type(app.stdin, "two", "\r", "fix the parser", "\r");
  return app;
}

describe("NewTaskForm", () => {
  test("opens on the repo step", () => {
    const { lastFrame, unmount } = render(
      <NewTaskForm knownRepos={REPOS} onSubmit={() => {}} onCancel={() => {}} />,
    );
    const frame = lastFrame()!;
    unmount(); // the text input parks the hardware cursor while mounted
    expect(frame).toContain("New task");
    expect(frame).toContain("repo:");
    expect(frame).toContain("/tmp/repo-one");
    expect(frame).not.toContain("title:"); // later steps stay hidden
    expect(frame).toContain("Enter to confirm");
  });

  test("repo -> title -> size in three steps", async () => {
    const app = await driveToSize();
    const frame = app.lastFrame()!;
    app.unmount();
    expect(frame).toContain("/tmp/repo-two");
    expect(frame).toContain("fix the parser");
    expect(frame).toContain("size:");
    expect(frame).toContain("[M]"); // default
    expect(frame).toContain("h/l size · Enter creates & opens $EDITOR");
  });

  test("no step ever asks about defer, worktree, permission or queueing", async () => {
    const app = render(<NewTaskForm knownRepos={REPOS} onSubmit={() => {}} onCancel={() => {}} />);
    const seen: string[] = [app.lastFrame()!];
    for (const chunk of ["two", "\r", "fix the parser", "\r"]) {
      await type(app.stdin, chunk);
      seen.push(app.lastFrame()!);
    }
    app.unmount();
    for (const frame of seen) {
      const text = strip(frame).toLowerCase();
      for (const word of ["defer", "permission", "worktree", "queue now"]) {
        expect(text).not.toContain(word);
      }
    }
  });

  // INPUT_COL/REPO_ROW/TITLE_ROW place the HARDWARE cursor (IME preedit
  // anchoring), so the layout above and left of the two inputs is load-bearing:
  // border, "New task", repo, title — and a 2-cell "│ " + 12-cell label.
  test("the repo/title rows sit where the cursor constants say they do", async () => {
    const app = await driveToSize();
    const rows = lines(app.lastFrame()!);
    app.unmount();
    const repoRow = rows.findIndex((l) => l.includes("repo:"));
    const titleRow = rows.findIndex((l) => l.includes("title:"));
    expect(rows[1]).toContain("New task"); // + the app's own header row = REPO_ROW-2
    expect(repoRow).toBe(2); // + the app header = screen row 4 = REPO_ROW
    expect(titleRow).toBe(repoRow + 1); // = TITLE_ROW
    // "│ " + "repo:       " = 14 cells, so the value starts at 1-indexed col 15
    expect(rows[repoRow]!.indexOf("/tmp/repo-two")).toBe(14);
    expect(rows[titleRow]!.indexOf("fix the parser")).toBe(14);
  });

  test("h/l pick the size and Enter submits {repo, title, size}", async () => {
    const drafts: NewTaskDraft[] = [];
    const app = await driveToSize((d) => drafts.push(d));
    await type(app.stdin, "h", "\r");
    app.unmount();
    expect(drafts).toEqual([{ repo: "/tmp/repo-two", title: "fix the parser", size: "S" }]);
  });

  test("Enter straight through keeps the default size", async () => {
    const drafts: NewTaskDraft[] = [];
    const app = await driveToSize((d) => drafts.push(d));
    await type(app.stdin, "\r");
    app.unmount();
    expect(drafts).toEqual([{ repo: "/tmp/repo-two", title: "fix the parser", size: "M" }]);
  });

  test("Esc cancels", async () => {
    let cancelled = false;
    const app = render(
      <NewTaskForm knownRepos={REPOS} onSubmit={() => {}} onCancel={() => { cancelled = true; }} />,
    );
    await type(app.stdin, "\x1b");
    app.unmount();
    expect(cancelled).toBe(true);
  });
});
