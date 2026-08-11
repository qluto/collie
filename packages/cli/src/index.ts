#!/usr/bin/env bun
import { runTaskCommand } from "./commands/task.ts";
import { runDoneCommand } from "./commands/done.ts";
import { runGcCommand } from "./commands/gc.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runHookCommand } from "./commands/hook.ts";
import { runDispatcherCommand } from "./commands/dispatcher.ts";

const USAGE = `collie — task queue for Claude Code sessions on Herdr

Usage:
  collie task add --repo <path> --title <t> [--size S|M|L] [--priority N]
                     [--no-worktree] [--permission-mode <m>]
                     [--prompt <text>]           (omit --prompt to open $EDITOR)
  collie task list [--status s1,s2] [--json]
  collie task show <id>
  collie task queue|retry|cancel|done <id>
  collie task complete <id> --summary "<text>"
  collie task fail <id> --reason "<text>" [--retryable]
  collie done [<id>] [--close]   # review -> done; id defaults to the task
                            # owning $COLLIE_TASK_ID or the focused herdr pane.
                            # --close also removes the worktree / closes the pane
  collie gc [--dry-run]     # drop finished tasks' worktrees and merged branches
  collie dispatcher run [--once] [--verbose] | status
  collie dispatcher install | restart | uninstall     (launchd)
  collie new [--popup]      # the capture form alone, for a herdr popup keybinding
  collie tui
  collie doctor
`;

async function main(argv: string[]): Promise<number> {
  const [group, ...rest] = argv;
  switch (group) {
    case "task":
      return runTaskCommand(rest);
    case "done":
      return runDoneCommand(rest);
    case "gc":
      return runGcCommand(rest);
    case "doctor":
      return runDoctor();
    case "dispatcher":
      return runDispatcherCommand(rest);
    case "hook":
      return runHookCommand(rest);
    case "new": {
      // Lazy, and from the subpath: the capture form must not drag the board,
      // the harvest view and their evidence caches into a popup.
      const { runNewTask } = await import("@collie/tui/new");
      return runNewTask({ popup: rest.includes("--popup") });
    }
    case "tui": {
      // Lazy import keeps ink/react out of dispatcher and hook processes.
      const { runTui } = await import("@collie/tui");
      runTui();
      return new Promise<number>(() => {}); // ink owns the process from here
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(`collie: unknown command "${group}"\n`);
      console.log(USAGE);
      return 2;
  }
}

process.exit(await main(process.argv.slice(2)));
