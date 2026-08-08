import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Suspend the Ink app's raw-mode terminal, run $EDITOR on a temp file seeded
 * with `initial`, and return the edited text (null when the editor failed).
 * The caller re-renders afterwards; Ink recovers the screen on next output.
 */
export function editInEditor(initial: string, suffix = ".md"): string | null {
  const editor = process.env.EDITOR ?? "vi";
  const tmp = path.join(os.tmpdir(), `agent-hub-edit-${process.pid}-${Date.now()}${suffix}`);
  fs.writeFileSync(tmp, initial);

  const wasRaw = process.stdin.isRaw;
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write("\x1b[2J\x1b[H"); // clear so the editor owns the screen
    const res = spawnSync(editor, [tmp], { stdio: "inherit" });
    if (res.status !== 0) return null;
    return fs.readFileSync(tmp, "utf8");
  } finally {
    if (process.stdin.isTTY && wasRaw) process.stdin.setRawMode(true);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
  }
}

/** Edit an existing file in place with $EDITOR (config.toml, task files). */
export function editFileInEditor(filePath: string): boolean {
  const editor = process.env.EDITOR ?? "vi";
  const wasRaw = process.stdin.isRaw;
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write("\x1b[2J\x1b[H");
    return spawnSync(editor, [filePath], { stdio: "inherit" }).status === 0;
  } finally {
    if (process.stdin.isTTY && wasRaw) process.stdin.setRawMode(true);
  }
}
