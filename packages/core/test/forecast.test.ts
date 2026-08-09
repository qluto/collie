import { describe, expect, test } from "bun:test";
import { computeForecast, forecastLine, type Forecast } from "../src/quota/forecast.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { LimitSnapshot } from "../src/quota/limits-api.ts";

const NOW = Date.UTC(2026, 0, 15, 22, 0, 0);
const quota = DEFAULT_CONFIG.quota; // full 0.85, conservative 0.35, week 0.9

function snapshot(over: Partial<LimitSnapshot> = {}): LimitSnapshot {
  return { sessionPct: 42, weeklyPct: 10, fetchedAt: NOW, ...over };
}

describe("computeForecast", () => {
  test("headroom and tasks left in a full window", () => {
    const f = computeForecast(
      quota,
      "full",
      snapshot({ sessionResetsAt: new Date(NOW + 190 * 60_000).toISOString() }),
      15,
      NOW,
    );
    expect(f.sessionPct).toBe(42);
    expect(f.capPct).toBe(85);
    expect(f.headroomPct).toBe(43);
    expect(f.minToReset).toBe(190);
    expect(f.resetsAt?.getTime()).toBe(NOW + 190 * 60_000);
    expect(f.tasksLeft).toBe(2); // 43 / 15
  });

  test("conservative mode caps at fraction_conservative", () => {
    const f = computeForecast(quota, "conservative", snapshot({ sessionPct: 20 }), 15, NOW);
    expect(f.capPct).toBe(35);
    expect(f.headroomPct).toBe(15);
    expect(f.tasksLeft).toBe(1);
  });

  test("headroom clamps to zero past the cap", () => {
    const f = computeForecast(quota, "conservative", snapshot({ sessionPct: 90 }), 15, NOW);
    expect(f.headroomPct).toBe(0);
    expect(f.tasksLeft).toBe(0);
  });

  test("a reset already in the past reads as zero minutes, never negative", () => {
    const f = computeForecast(
      quota,
      "full",
      snapshot({ sessionResetsAt: new Date(NOW - 5 * 60_000).toISOString() }),
      15,
      NOW,
    );
    expect(f.minToReset).toBe(0);
  });

  test("missing or unparseable sessionResetsAt leaves the reset fields undefined", () => {
    for (const sessionResetsAt of [undefined, "", "soon-ish"]) {
      const f = computeForecast(quota, "full", snapshot({ sessionResetsAt }), 15, NOW);
      expect(f.resetsAt).toBeUndefined();
      expect(f.minToReset).toBeUndefined();
    }
  });

  test("an unusable pct-per-task yields no task estimate rather than Infinity", () => {
    expect(computeForecast(quota, "full", snapshot(), 0, NOW).tasksLeft).toBeNull();
  });
});

describe("forecastLine", () => {
  const base: Forecast = {
    sessionPct: 42,
    capPct: 85,
    headroomPct: 43,
    tasksLeft: 5,
  };

  test("compact line without a reset time", () => {
    expect(forecastLine(base, 10, 90)).toBe("session 42% · headroom 43% ≈5 tasks");
  });

  test("weekly only appears once it is near its cap", () => {
    expect(forecastLine(base, 76, 90)).toBe("session 42% · headroom 43% ≈5 tasks · wk 76%");
    expect(forecastLine(base, 74, 90)).not.toContain("wk");
  });

  test("singular task, and no estimate when tasksLeft is unknown", () => {
    expect(forecastLine({ ...base, tasksLeft: 1 }, 0, 90)).toBe("session 42% · headroom 43% ≈1 task");
    expect(forecastLine({ ...base, tasksLeft: null }, 0, 90)).toBe("session 42% · headroom 43%");
  });

  test("reset time is local wall clock with a duration", () => {
    const resetsAt = new Date(NOW + 190 * 60_000);
    const line = forecastLine({ ...base, resetsAt, minToReset: 190 }, 0, 90);
    // the clock part is local-timezone dependent; the shape is not
    expect(line).toMatch(/^session 42% · resets \d\d:\d\d \(\+3h10m\) · headroom 43% ≈5 tasks$/);
    expect(forecastLine({ ...base, resetsAt, minToReset: 45 }, 0, 90)).toContain("(+45m)");
    expect(forecastLine({ ...base, resetsAt, minToReset: 120 }, 0, 90)).toContain("(+2h)");
  });
});
