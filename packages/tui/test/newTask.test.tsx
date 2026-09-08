import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { NewTaskForm, type NewTaskDraft } from "../src/views/newTask.tsx";

const REPOS = ["/tmp/repo-one", "/tmp/repo-two"];
const MODELS = ["sonnet", "opus", "fable"];

/**
 * The form stats the chosen path for real; these fixtures are not checkouts.
 * Every test but the validation one below is about the three-step flow, so
 * they render with the check stubbed out.
 */
const ok = () => null;

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
  const app = render(
    <NewTaskForm knownRepos={REPOS} checkRepo={ok} modelChoices={MODELS} onSubmit={onSubmit} onCancel={() => {}} />,
  );
  await type(app.stdin, "two", "\r", "fix the parser", "\r");
  return app;
}

describe("NewTaskForm", () => {
  test("opens on the repo step", () => {
    const { lastFrame, unmount } = render(
      <NewTaskForm knownRepos={REPOS} checkRepo={ok} onSubmit={() => {}} onCancel={() => {}} />,
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
    expect(frame).toContain("h/l size · Enter next");
    expect(frame).not.toContain("model:"); // the model step is still ahead
  });

  // The point of checking here rather than at createTask: past this field the
  // form asks two more questions and opens $EDITOR. Learning the path was
  // wrong after writing a prompt — or next morning, after the dispatcher
  // choked on it at 2am — is the disappointment the check exists to prevent.
  test("a bad repo stops the form at the first field, with the reason", async () => {
    const app = render(
      <NewTaskForm
        knownRepos={REPOS}
        checkRepo={(r) => (r === "/tmp/repo-two" ? null : "is not a git repository")}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    await type(app.stdin, "\x1b[A", "/nope"); // ↑ past the top = free input
    expect(strip(app.lastFrame()!)).toContain("/nope — is not a git repository");

    await type(app.stdin, "\r");
    const frame = strip(app.lastFrame()!);
    app.unmount();
    expect(frame).not.toContain("title:"); // Enter did not advance
    expect(frame).toContain("/nope — is not a git repository");
  });

  test("a good repo clears the way", async () => {
    const app = render(
      <NewTaskForm
        knownRepos={REPOS}
        checkRepo={(r) => (r === "/tmp/repo-two" ? null : "is not a git repository")}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    await type(app.stdin, "two", "\r");
    const frame = strip(app.lastFrame()!);
    app.unmount();
    expect(frame).toContain("title:");
    expect(frame).not.toContain("is not a git repository");
  });

  test("no step ever asks about worktree, permission or queueing", async () => {
    const app = render(<NewTaskForm knownRepos={REPOS} checkRepo={ok} onSubmit={() => {}} onCancel={() => {}} />);
    const seen: string[] = [app.lastFrame()!];
    for (const chunk of ["two", "\r", "fix the parser", "\r"]) {
      await type(app.stdin, chunk);
      seen.push(app.lastFrame()!);
    }
    app.unmount();
    for (const frame of seen) {
      const text = strip(frame).toLowerCase();
      for (const word of ["permission", "worktree", "queue now"]) {
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

  test("h/l pick the size, then the model, and Enter submits", async () => {
    const drafts: NewTaskDraft[] = [];
    const app = await driveToSize((d) => drafts.push(d));
    await type(app.stdin, "h", "\r"); // size S, on to the model step
    expect(strip(app.lastFrame()!)).toContain("[(default)]");
    expect(strip(app.lastFrame()!)).toContain("h/l model · Enter creates & opens $EDITOR");
    await type(app.stdin, "l", "l", "l", "l", "\r"); // clamps at the last choice
    app.unmount();
    expect(drafts).toEqual([
      { repo: "/tmp/repo-two", title: "fix the parser", size: "S", model: "fable" },
    ]);
  });

  test("Enter straight through keeps the default size and names no model", async () => {
    const drafts: NewTaskDraft[] = [];
    const app = await driveToSize((d) => drafts.push(d));
    await type(app.stdin, "\r", "\r");
    app.unmount();
    expect(drafts).toEqual([
      { repo: "/tmp/repo-two", title: "fix the parser", size: "M", model: undefined },
    ]);
  });

  test("Esc cancels", async () => {
    let cancelled = false;
    const app = render(
      <NewTaskForm knownRepos={REPOS} checkRepo={ok} onSubmit={() => {}} onCancel={() => { cancelled = true; }} />,
    );
    await type(app.stdin, "\x1b");
    app.unmount();
    expect(cancelled).toBe(true);
  });
});

describe("collie new (standalone popup form)", () => {
  // The inputs park the hardware cursor at REPO_ROW/TITLE_ROW counted from the
  // top of the screen, so the popup view must spend exactly as many lines above
  // the form as the TUI does. This test is what notices when it stops doing so.
  test("the inputs land on the rows the cursor is parked at", async () => {
    const { REPO_ROW, TITLE_ROW } = await import("../src/views/newTask.tsx");
    const { Standalone } = await import("../src/new.tsx");

    const repoStep = render(<Standalone knownRepos={REPOS} checkRepo={ok} onDone={() => {}} />);
    const repoLines = lines(repoStep.lastFrame()!);
    repoStep.unmount();
    expect(repoLines.findIndex((l) => l.includes("repo:")) + 1).toBe(REPO_ROW);

    const titleStep = render(<Standalone knownRepos={REPOS} checkRepo={ok} onDone={() => {}} />);
    await type(titleStep.stdin, "two", "\r");
    const titleLines = lines(titleStep.lastFrame()!);
    titleStep.unmount();
    expect(titleLines.findIndex((l) => l.includes("title:")) + 1).toBe(TITLE_ROW);
  });
});
