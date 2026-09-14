import { describe, expect, test } from "bun:test";
import { displayWidth, hyperlink, padToWidth, truncateToWidth } from "../src/cursor.ts";

describe("displayWidth", () => {
  test("ascii is one cell, CJK two", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("日本語")).toBe(6);
    expect(displayWidth("あa")).toBe(3);
  });

  test("emoji-presentation symbols are two cells, their text cousins one", () => {
    // the group markers the group headers are built from
    expect(displayWidth("✅")).toBe(2);
    expect(displayWidth("❓")).toBe(2);
    expect(displayWidth("❌")).toBe(2);
    expect(displayWidth("📦")).toBe(2);
    // same block, text presentation — one cell, and a table that guessed by
    // block would get these wrong
    expect(displayWidth("✓")).toBe(1);
    expect(displayWidth("✗")).toBe(1);
    expect(displayWidth("·")).toBe(1);
  });

  test("a variation selector decides the width, and costs nothing itself", () => {
    expect(displayWidth("⚙")).toBe(1);
    expect(displayWidth("⚙️")).toBe(2); // U+2699 U+FE0F
    expect(displayWidth("⚙️ x")).toBe(4);
  });
});

describe("padToWidth", () => {
  test("pads to an exact cell count whatever the label holds", () => {
    for (const label of ["🕐 schedule", "🐕 herdr", "quota", "日本語ラベル"]) {
      expect(displayWidth(padToWidth(label, 12))).toBe(12);
    }
  });

  test("a label longer than the column is truncated, not overflowed", () => {
    expect(displayWidth(padToWidth("📊 a very long section label", 12))).toBe(12);
    expect(padToWidth("📊 a very long section label", 12)).toContain("…");
  });

  test("truncateToWidth stays the authority on the cut", () => {
    expect(truncateToWidth("abcdef", 4)).toBe("abc…");
  });
});

describe("hyperlink", () => {
  test("wraps the text in OSC 8, leaving the visible text untouched", () => {
    const link = hyperlink("#12", "https://example.test/pull/12");
    expect(link).toBe("\x1b]8;;https://example.test/pull/12\x1b\\#12\x1b]8;;\x1b\\");
    expect(link.replace(/\x1b]8;;[^\x1b]*\x1b\\/g, "")).toBe("#12");
  });

  test("the escapes are added after the width arithmetic, never measured by it", () => {
    const visible = truncateToWidth("#12 https://example.test/pull/12", 10);
    expect(displayWidth(visible)).toBe(10);
    // the link around it is invisible to the terminal's cell count
    expect(hyperlink(visible, "https://example.test/pull/12")).toContain(visible);
  });
});
