import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

export const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[H";
export const LEAVE_ALT_SCREEN = "\x1b[?1049l";

/** Set by runTui so editor helpers can force a full Ink repaint after $EDITOR. */
let repaint: (() => void) | undefined;
export function setRepaint(fn: () => void): void {
  repaint = fn;
}

/**
 * Suspend the Ink app's raw-mode terminal, run $EDITOR on a temp file seeded
 * with `initial`, and return the edited text (null when the editor failed).
 * The caller re-renders afterwards; Ink recovers the screen on next output.
 */
export function editInEditor(initial: string, suffix = ".md"): string | null {
  const editor = process.env.EDITOR ?? "vi";
  const tmp = path.join(os.tmpdir(), `collie-edit-${process.pid}-${Date.now()}${suffix}`);
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
    // full-screen editors toggle the alt screen themselves and drop us back to
    // the main buffer on exit — re-enter ours and repaint from scratch
    process.stdout.write(ENTER_ALT_SCREEN);
    repaint?.();
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
    process.stdout.write(ENTER_ALT_SCREEN);
    repaint?.();
  }
}
