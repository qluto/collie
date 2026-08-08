/**
 * Hardware-cursor control for IME-friendly text input.
 *
 * Terminal IMEs draw the preedit (unconfirmed composition) at the HARDWARE
 * cursor position. Ink hides the cursor and leaves it wherever its frame
 * ended, so the preedit appears detached at the bottom of the screen. While a
 * text field has focus we re-place and show the cursor at the field's logical
 * position after every render, which pins the preedit inline — the same
 * approach Claude Code's input box uses.
 */

let pending: ReturnType<typeof setImmediate> | undefined;

/** Move the hardware cursor to a 1-indexed (row, col) cell and show it. */
export function placeCursor(row: number, col: number): void {
  if (pending) clearImmediate(pending);
  // setImmediate lands after Ink's own stdout flush for this commit
  pending = setImmediate(() => {
    process.stdout.write(`\x1b[${row};${col}H\x1b[?25h`);
  });
}

export function hideCursor(): void {
  if (pending) clearImmediate(pending);
  process.stdout.write("\x1b[?25l");
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
