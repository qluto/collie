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

// East-asian-wide and emoji ranges render as 2 terminal cells. The scattered
// ranges below 0x2e80 are the East_Asian_Width=W codepoints in the symbol
// blocks — the emoji-presentation ones (✅ ❌ ⚠ …) that a terminal draws two
// cells wide while their text-presentation neighbours (✓ ✗) stay one. Guessing
// by block would be wrong in both directions.
const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec],
  [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce],
  [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1faff], [0x20000, 0x3fffd],
] as const;

// Zero-width companions of an emoji: the presentation selector and the joiner
// occupy no cell of their own.
const ZERO = new Set([0xfe0f, 0xfe0e, 0x200d]);

/** Terminal display width of a string (wide chars count 2 cells). */
export function displayWidth(s: string): number {
  const chars = [...s];
  let width = 0;
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i]!.codePointAt(0)!;
    if (ZERO.has(cp)) continue;
    // A variation selector decides the presentation, and with it the width:
    // "⚙" is one cell, "⚙️" (+U+FE0F) is drawn as an emoji across two.
    const next = chars[i + 1]?.codePointAt(0);
    if (next === 0xfe0f) width += 2;
    else if (next === 0xfe0e) width += 1;
    else width += WIDE.some(([lo, hi]) => cp >= lo && cp <= hi) ? 2 : 1;
  }
  return width;
}

/** Right-pad to a cell budget so a label column lines up whatever it holds. */
export function padToWidth(s: string, cells: number): string {
  const cut = truncateToWidth(s, cells);
  return cut + " ".repeat(Math.max(0, cells - displayWidth(cut)));
}

/**
 * Truncate to a cell budget, appending "…" when it doesn't fit. Ink's own
 * wrap="truncate" miscounts CJK by a cell and pushes the line past the pane
 * width, so every string the views draw goes through this instead.
 */
export function truncateToWidth(s: string, cells: number): string {
  if (cells <= 0) return "";
  if (displayWidth(s) <= cells) return s;
  let out = "";
  let width = 0;
  for (const ch of s) {
    const w = displayWidth(ch);
    if (width + w > cells - 1) break; // reserve one cell for the ellipsis
    out += ch;
    width += w;
  }
  return `${out}…`;
}

/**
 * Break into at most `maxLines` lines of `cells` display width; the last line
 * gets an "…" when text remains. Breaks at a space when one is available so
 * English titles don't split mid-word — CJK has no spaces and wraps anywhere.
 */
export function wrapToWidth(s: string, cells: number, maxLines: number): string[] {
  if (cells <= 0 || maxLines <= 0) return [];
  let rest = s;
  const lines: string[] = [];
  while (rest.length > 0 && lines.length < maxLines) {
    if (displayWidth(rest) <= cells) {
      lines.push(rest);
      return lines;
    }
    if (lines.length === maxLines - 1) break; // last line: truncate below
    let cut = "";
    let width = 0;
    for (const ch of rest) {
      const w = displayWidth(ch);
      if (width + w > cells) break;
      cut += ch;
      width += w;
    }
    const lastSpace = cut.lastIndexOf(" ");
    if (lastSpace > 0 && rest[cut.length] !== " ") cut = cut.slice(0, lastSpace);
    lines.push(cut);
    rest = rest.slice(cut.length).replace(/^ +/, "");
  }
  if (rest) lines.push(truncateToWidth(rest, cells));
  return lines;
}
