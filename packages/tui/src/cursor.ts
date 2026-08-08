/**
 * Hardware-cursor control for IME-friendly text input.
 *
 * Terminal IMEs draw the preedit (unconfirmed composition) at the HARDWARE
 * cursor position. Ink hides the cursor and leaves it wherever its frame
 * ended, so the preedit appears detached at the bottom of the screen. While a
 * text field has focus we re-place and show the cursor at the field's logical
 * position after every render, which pins the preedit inline — the same
 * approach Claude Code's input box uses.
 *
 * CRITICAL invariant: Ink repaints frames RELATIVE to where it last left the
 * cursor. If the cursor is still parked at the input field when Ink writes
 * its next frame, Ink's erase/rewrite starts from the wrong origin and the
 * whole frame lands at the wrong place (observed as the UI jumping to the
 * bottom of the screen after an IME commit). So: save Ink's position (DECSC)
 * before parking the cursor, and restore it (DECRC) immediately before any
 * write we didn't issue ourselves — i.e. Ink's next frame.
 */

let pending: ReturnType<typeof setImmediate> | undefined;
let rawWrite: ((chunk: string) => void) | undefined;
let parked = false;

function ensureStdoutPatched(): void {
  if (rawWrite) return;
  const orig = process.stdout.write.bind(process.stdout);
  rawWrite = (chunk: string) => {
    orig(chunk);
  };
  process.stdout.write = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
    if (parked) {
      // Ink (or anyone else) is about to draw: hand the cursor back to the
      // exact cell Ink expects before its relative repositioning runs.
      parked = false;
      orig("\x1b8\x1b[?25l");
    }
    return orig(chunk as never, enc as never, cb as never);
  }) as typeof process.stdout.write;
}

/** Move the hardware cursor to a 1-indexed (row, col) cell and show it. */
export function placeCursor(row: number, col: number): void {
  ensureStdoutPatched();
  if (pending) clearImmediate(pending);
  // setImmediate lands after Ink's stdout flush for this commit, so DECSC
  // captures Ink's true resting position
  pending = setImmediate(() => {
    parked = false; // our own write below must not trigger the restore path
    rawWrite!(`\x1b7\x1b[${row};${col}H\x1b[?25h`);
    parked = true;
  });
}

export function hideCursor(): void {
  if (pending) {
    clearImmediate(pending);
    pending = undefined;
  }
  if (parked && rawWrite) {
    parked = false;
    rawWrite("\x1b8");
  }
  (rawWrite ?? process.stdout.write.bind(process.stdout))("\x1b[?25l");
}

// East-asian-wide and emoji ranges render as 2 terminal cells.
const WIDE = [
  [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1faff], [0x20000, 0x3fffd],
] as const;

/** Terminal display width of a string (wide chars count 2 cells). */
export function displayWidth(s: string): number {
  let width = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    width += WIDE.some(([lo, hi]) => cp >= lo && cp <= hi) ? 2 : 1;
  }
  return width;
}
