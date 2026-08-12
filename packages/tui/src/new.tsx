import React from "react";
import { Box, Text, render } from "ink";
import {
  closePopup, createTask, discoverRepos, listTasks, loadConfig, repoRootOf, showNotification,
  stripPromptTemplate,
} from "@collie/core";
import { NewTaskForm, type NewTaskDraft } from "./views/newTask.tsx";
import { ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN, editInEditor } from "./editor.ts";

/**
 * The capture form on its own, for a herdr `type = "popup"` keybinding: toss a
 * task in from whatever pane you are standing in, without leaving it.
 *
 * The form's text inputs park the hardware cursor at rows counted from the top
 * of the SCREEN (REPO_ROW/TITLE_ROW in newTask.tsx) so a CJK IME can anchor its
 * preedit there. That geometry assumes exactly ONE line above the form — the
 * line the TUI spends on its tab bar — so this view keeps one too. A taller
 * header here silently moves the preedit off the input.
 */
export function Standalone(props: {
  knownRepos: string[];
  /** forwarded to the form; only the row-geometry tests pass it */
  checkRepo?: (repo: string) => string | null;
  onDone: (draft: NewTaskDraft | null) => void;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text dimColor>🐑 collie — new task</Text>
      <NewTaskForm
        knownRepos={props.knownRepos}
        checkRepo={props.checkRepo}
        onSubmit={props.onDone}
        onCancel={() => props.onDone(null)}
      />
    </Box>
  );
}

/**
 * Repos worth offering, likeliest first. A popup inherits the calling pane's
 * cwd (herdr's `new_cwd = "follow"`), so the repo the human is standing in is
 * the best guess there is.
 */
function knownRepos(): string[] {
  const here = repoRootOf(process.cwd());
  let discovered: string[] = [];
  try {
    discovered = discoverRepos(loadConfig().repos.roots);
  } catch {
    // unreadable roots: the recent-task repos are still worth offering
  }
  let recent: string[] = [];
  try {
    recent = listTasks().map((t) => t.repo);
  } catch {
    // a brand new home has no tasks yet
  }
  return [...new Set([...(here ? [here] : []), ...recent, ...discovered])];
}

/** Say it twice: to stdout for a terminal, as a toast for a popup that closed. */
async function report(message: string, sound: "none" | "done" | "request"): Promise<void> {
  console.log(message);
  await showNotification(message, sound);
}

export async function runNewTask(opts: { popup?: boolean } = {}): Promise<number> {
  const repos = knownRepos();

  process.stdout.write(ENTER_ALT_SCREEN);
  let settle: (draft: NewTaskDraft | null) => void = () => {};
  const answered = new Promise<NewTaskDraft | null>((resolve) => {
    settle = resolve;
  });
  const app = render(<Standalone knownRepos={repos} onDone={(d) => settle(d)} />, {
    exitOnCtrlC: true,
  });
  void app.waitUntilExit().then(() => settle(null)); // ctrl+c
  const draft = await answered;
  app.unmount();
  process.stdout.write(LEAVE_ALT_SCREEN);

  const finish = async (code: number, message: string, sound: "none" | "done" | "request") => {
    await report(message, sound);
    // last: herdr tears the popup's PTY down with it
    if (opts.popup) await closePopup();
    return code;
  };

  if (!draft) return finish(0, "cancelled; no task created", "none");

  const raw = editInEditor(
    `<!-- Prompt for "${draft.title}". Save & quit to create the task. -->\n\n`,
    { restoreAltScreen: false },
  );
  if (raw === null) return finish(1, "editor exited non-zero; task not created", "request");
  const prompt = stripPromptTemplate(raw);
  if (prompt.length === 0) return finish(1, "empty prompt; task not created", "request");

  // worktree / permission mode / priority come from config defaults inside
  // createTask — a toss-in never answers them
  // The form already refused a bad repo, but it could have gone away while
  // $EDITOR was open — and in a popup an uncaught throw is total silence.
  let task;
  try {
    task = createTask(
      { title: draft.title, repo: draft.repo, prompt, size: draft.size },
      { source: opts.popup ? "popup" : "cli" },
    );
  } catch (err) {
    return finish(1, `not created: ${(err as Error).message}`, "request");
  }
  return finish(0, `queued ${task.id} · ${task.title}`, "done");
}
