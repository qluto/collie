import * as fs from "node:fs";
import * as path from "node:path";
import { runsDir } from "@collie/core";
import type { Task } from "@collie/core";

/** Absolute "bun <cli-entry>" invocation used in prompts and hook settings. */
export function absBin(): string {
  const entry = path.resolve(import.meta.dir, "..", "index.ts");
  return `${process.execPath} ${entry}`;
}

export function promptPath(taskId: string): string {
  return path.join(runsDir(taskId), "prompt.md");
}

export function settingsPath(taskId: string): string {
  return path.join(runsDir(taskId), "settings.json");
}

const HOOK_EVENTS = ["SessionStart", "Stop", "Notification", "PostToolUse", "SessionEnd"] as const;

export function writeRunArtifacts(task: Task): void {
  fs.mkdirSync(runsDir(task.id), { recursive: true });

  const footer = `

---
## Completion protocol (mandatory)
When the task above is fully complete and verified, run exactly:

    ${absBin()} task complete ${task.id} --summary "<one line: what was done + how it was verified>"

If you determine the task cannot be completed, run:

    ${absBin()} task fail ${task.id} --reason "<one line>" --retryable

Do this as your final action. Do not ask whether to run it.
`;
  fs.writeFileSync(promptPath(task.id), task.prompt + footer);

  const hookCommand = (name: string) => `${absBin()} hook ${name}`;
  const settings = {
    permissions: {
      // The completion callback must never hit a permission prompt at 3am.
      allow: [`Bash(${absBin()} task:*)`],
      additionalDirectories: [runsDir(task.id)],
    },
    hooks: Object.fromEntries(
      HOOK_EVENTS.map((event) => [
        event,
        [{ hooks: [{ type: "command", command: hookCommand(event.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()) }] }],
      ]),
    ),
  };
  fs.writeFileSync(settingsPath(task.id), JSON.stringify(settings, null, 2));
}

/** The one-line pointer injected into the interactive claude session. */
export function pointerPrompt(taskId: string): string {
  return `Read the file ${promptPath(taskId)} and carry out the task it specifies. Follow its completion-reporting instructions exactly.`;
}
