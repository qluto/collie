import { describe, expect, test } from "bun:test";
import { resolveMode } from "../src/schedule.ts";
import type { Config } from "../src/types.ts";

const at = (h: number, m = 0) => {
  const d = new Date(2026, 7, 8); // local, arbitrary date
  d.setHours(h, m, 0, 0);
  return d;
};

const sched = (windows: Config["schedule"]["windows"]): Config["schedule"] => ({
  windows,
  defaultMode: "conservative",
});

describe("resolveMode", () => {
  test("simple day window", () => {
    const s = sched([{ start: "00:00", end: "07:00", mode: "full" }]);
    expect(resolveMode(s, at(0, 0))).toBe("full");
    expect(resolveMode(s, at(6, 59))).toBe("full");
    expect(resolveMode(s, at(7, 0))).toBe("conservative"); // end exclusive
    expect(resolveMode(s, at(23, 30))).toBe("conservative");
  });

  test("midnight-crossing window", () => {
    const s = sched([{ start: "22:00", end: "06:00", mode: "full" }]);
    expect(resolveMode(s, at(22, 0))).toBe("full");
    expect(resolveMode(s, at(23, 59))).toBe("full");
    expect(resolveMode(s, at(0, 30))).toBe("full");
    expect(resolveMode(s, at(5, 59))).toBe("full");
    expect(resolveMode(s, at(6, 0))).toBe("conservative");
    expect(resolveMode(s, at(12, 0))).toBe("conservative");
  });

  test("first matching window wins; paused window", () => {
    const s = sched([
      { start: "09:00", end: "18:00", mode: "paused" },
      { start: "00:00", end: "23:59", mode: "full" },
    ]);
    expect(resolveMode(s, at(10, 0))).toBe("paused");
    expect(resolveMode(s, at(20, 0))).toBe("full");
  });

  test("no windows -> default", () => {
    expect(resolveMode(sched([]), at(3, 0))).toBe("conservative");
  });
});
