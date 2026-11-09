import { describe, expect, test } from "bun:test";
import { taskLabel } from "../src/herdr/metadata.ts";

describe("taskLabel", () => {
  test("uses the title, not the id", () => {
    expect(taskLabel({ id: "t-20261109-a3f2", title: "ログイン画面のバグ修正" })).toBe("ログイン画面のバグ修正");
  });
  test("falls back to the id for an empty or blank title", () => {
    expect(taskLabel({ id: "t-1", title: "" })).toBe("t-1");
    expect(taskLabel({ id: "t-1", title: "  \n " })).toBe("t-1");
    expect(taskLabel({ id: "t-1" })).toBe("t-1");
  });
  test("collapses whitespace so a label stays one line", () => {
    expect(taskLabel({ id: "t-1", title: " fix\n  the\tthing " })).toBe("fix the thing");
  });
  test("caps long titles by code point with an ellipsis", () => {
    const label = taskLabel({ id: "t-1", title: "あ".repeat(60) });
    expect([...label].length).toBe(40);
    expect(label.endsWith("…")).toBe(true);
    expect(taskLabel({ id: "t-1", title: "x".repeat(40) })).toBe("x".repeat(40));
  });
});
