import React, { useEffect, useRef } from "react";
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

  // An IME commit arrives as a rapid burst that Ink may deliver across
  // SEVERAL useInput calls inside one React batch. Each call would see the
  // same stale `value` prop, so computing `value + input` loses every chunk
  // but the last (observed as the first characters vanishing). Accumulate
  // synchronously in a ref instead; the effect below adopts external updates.
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useInput((input, key) => {
    if (key.return) {
      onSubmit();
      return;
    }
    if (key.backspace || key.delete) {
      valueRef.current = Array.from(valueRef.current).slice(0, -1).join("");
      onChange(valueRef.current);
      return;
    }
    if (
      input.length > 0 &&
      !key.ctrl && !key.meta && !key.escape && !key.tab &&
      !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow
    ) {
      valueRef.current += input;
      onChange(valueRef.current);
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
