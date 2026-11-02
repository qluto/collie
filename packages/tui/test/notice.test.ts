import { describe, expect, test } from "bun:test";
import type { UpdateCheck } from "@collie/core";
import { codeNotice } from "../src/notice.ts";

const update = (over: Partial<UpdateCheck> = {}): UpdateCheck => ({
  checkedAt: new Date().toISOString(), commit: "new", current: "v0.2.0", latest: "v0.3.0", ...over,
});
const base = {
  diskCommit: "new", tuiCommit: "new", dispatcherCommit: "new", dispatcherAlive: true,
  update: null as UpdateCheck | null, updateCheckEnabled: true,
};

describe("codeNotice", () => {
  test("nothing to say when everything runs the checked-out code and no release is newer", () => {
    expect(codeNotice(base)).toBeNull();
    expect(codeNotice({ ...base, update: update({ latest: "v0.2.0" }) })).toBeNull();
  });

  test("a dispatcher on old code outranks everything", () => {
    const n = codeNotice({ ...base, dispatcherCommit: "old", tuiCommit: "old", update: update() });
    expect(n).toEqual({ text: "↻ dispatcher on old code", color: "yellow" });
  });

  test("a dead dispatcher's stale state file is not drift", () => {
    expect(codeNotice({ ...base, dispatcherCommit: "old", dispatcherAlive: false })).toBeNull();
  });

  test("the TUI's own old code says what fixes it", () => {
    expect(codeNotice({ ...base, tuiCommit: "old" })?.text).toBe("↻ old code — restart tui");
  });

  test("a newer release names the version and the command", () => {
    expect(codeNotice({ ...base, update: update() })).toEqual({ text: "↑ v0.3.0 · collie update", color: "cyan" });
  });

  test("a check made against an older HEAD, or switched off, stays quiet", () => {
    expect(codeNotice({ ...base, update: update({ commit: "older" }) })).toBeNull();
    expect(codeNotice({ ...base, update: update(), updateCheckEnabled: false })).toBeNull();
  });
});
