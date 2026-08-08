#!/usr/bin/env bun
import { runTaskCommand } from "./commands/task.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runHookCommand } from "./commands/hook.ts";
import { runDispatcherCommand } from "./commands/dispatcher.ts";

const USAGE = `agent-hub — task queue for Claude Code sessions on Herdr

Usage:
  agent-hub task add --repo <path> --title <t> [--size S|M|L] [--priority N]
                     [--no-worktree] [--permission-mode <m>] [--queue]
                     [--prompt <text>]           (omit --prompt to open $EDITOR)
  agent-hub task list [--status s1,s2] [--json]
  agent-hub task show <id>
  agent-hub task queue|backlog|retry|cancel|done <id>
  agent-hub task complete <id> --summary "<text>"
  agent-hub task fail <id> --reason "<text>" [--retryable]
  agent-hub doctor
`;

async function main(argv: string[]): Promise<number> {
  const [group, ...rest] = argv;
  switch (group) {
    case "task":
      return runTaskCommand(rest);
    case "doctor":
      return runDoctor();
    case "dispatcher":
      return runDispatcherCommand(rest);
    case "hook":
      return runHookCommand(rest);
    case "tui": {
      // Lazy import keeps ink/react out of dispatcher and hook processes.
      const { runTui } = await import("@agent-hub/tui");
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
      console.error(`agent-hub: unknown command "${group}"\n`);
      console.log(USAGE);
      return 2;
  }
}

process.exit(await main(process.argv.slice(2)));
