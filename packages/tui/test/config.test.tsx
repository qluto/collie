import { describe, expect, test, beforeEach } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigView } from "../src/views/config.tsx";
import { displayWidth, padToWidth } from "../src/cursor.ts";

// Never the real ~/.collie: loadConfig WRITES the default file when it is
// missing, so every render here needs a throwaway home.
function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collie-config-view-"));
  process.env.COLLIE_HOME = dir;
  return dir;
}

const frameOf = (columns: number, rows: number): string =>
  render(<ConfigView columns={columns} rows={rows} />).lastFrame()!;

const bare = (frame: string): string[] =>
  frame.split("\n").map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

beforeEach(() => {
  freshHome();
});

describe("ConfigView", () => {
  test("every gate the dispatcher consults has a labelled section", () => {
    const frame = frameOf(100, 30);
    for (const label of ["🕐 schedule", "🧍 presence", "🚦 dispatch", "📊 quota", "🌱 defaults", "🐕 herdr", "📁 repos"]) {
      expect(frame).toContain(label);
    }
    // the two gates that used to be invisible in the TUI
    expect(frame).toContain("burn-down");
    expect(frame).toContain("off · the schedule decides alone");
    expect(frame).toContain("e edit in $EDITOR");
  });

  // This tab is the only place the file's word and the header's word meet, so
  // a reader who wondered what "conservative" buys them gets the answer here
  // rather than having to hold two vocabularies.
  test("each schedule mode is shown next to what it will actually pick up", () => {
    const frame = frameOf(100, 30);
    expect(frame).toContain("00:00-07:00 full — any size");
    expect(frame).toContain("outside every window: conservative — up to M");
    expect(frame).not.toContain("cons max"); // the abbreviation this replaced
  });

  test("values line up in one column, sections are separated when there is room", () => {
    const lines = bare(frameOf(100, 30));
    const starts: Array<[string, string]> = [
      ["🕐 schedule", "00:00"], ["🧍 presence", "off"], ["🚦 dispatch", "wip"],
      ["📊 quota", "session cap"], ["🌱 defaults", "permission"],
    ];
    for (const [label, value] of starts) {
      // the value begins at the same cell for every section
      expect(lines.some((l) => l.includes(padToWidth(label, 12) + value))).toBe(true);
    }
    expect(lines.filter((l) => l.trim() === "").length).toBeGreaterThan(2);
  });

  test("a short pane drops the blank lines first, then says what fell off", () => {
    for (const rows of [30, 18, 12, 7]) {
      const lines = bare(frameOf(80, rows));
      expect(lines.length).toBeLessThanOrEqual(rows);
      for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(80);
    }
    expect(frameOf(80, 12)).not.toMatch(/\n\s*\n\s*🧍/); // packed: no separator
    expect(frameOf(80, 7)).toMatch(/… \+\d+ lines/);
  });

  test("a narrow pane truncates instead of wrapping", () => {
    for (const line of bare(frameOf(44, 24))) {
      expect(displayWidth(line)).toBeLessThanOrEqual(44);
    }
  });

  test("an unreadable config reports the parse error instead of a blank tab", () => {
    fs.writeFileSync(path.join(process.env.COLLIE_HOME!, "config.toml"), "dispatch = [[[\n");
    const frame = frameOf(80, 24);
    expect(frame).not.toContain("🚦 dispatch");
    expect(frame.length).toBeGreaterThan(0);
  });
});
