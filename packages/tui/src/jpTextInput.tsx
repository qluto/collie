import React, { useEffect } from "react";
import { Text, useInput } from "ink";
import { displayWidth, hideCursor, placeCursor } from "./cursor.ts";

/**
 * IME-friendly single-line text input.
 *
 * Differences from ink-text-input that matter for Japanese:
 * - whole input chunks are appended verbatim, so a multi-character IME commit
 *   (or paste) never loses characters;
 * - backspace deletes by code point, not UTF-16 unit;
 * - no fake inverse-block cursor — instead the REAL terminal cursor is placed
 *   right after the value every frame, so the IME preedit renders inline at
 *   the field (row/col are the 1-indexed screen cell where the value starts).
 */
export function JpTextInput(props: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  row: number;
  col: number;
}): React.JSX.Element {
  const { value, onChange, onSubmit, row, col } = props;

  useInput((input, key) => {
    if (key.return) {
      onSubmit();
      return;
    }
    if (key.backspace || key.delete) {
      onChange(Array.from(value).slice(0, -1).join(""));
      return;
    }
    if (
      input.length > 0 &&
      !key.ctrl && !key.meta && !key.escape && !key.tab &&
      !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow
    ) {
      onChange(value + input);
    }
  });

  // re-place the cursor after EVERY render — Ink rewrites the frame (and
  // moves the hardware cursor) on each commit, not only when value changes
  useEffect(() => {
    placeCursor(row, col + displayWidth(value));
  });
  useEffect(() => () => hideCursor(), []);

  return <Text>{value}</Text>;
}
