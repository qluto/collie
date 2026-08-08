import { describe, expect, test } from "bun:test";
import { detectLimitHit, parseResetPhrase } from "../src/quota/limits.ts";

// Fixed reference: Saturday 2026-08-08 03:00 local
const NOW = new Date(2026, 7, 8, 3, 0, 0);

describe("detectLimitHit", () => {
  test("session limit", () => {
    const hit = detectLimitHit("some output\nYou've hit your session limit · resets 3:45pm\n", NOW);
    expect(hit?.kind).toBe("session");
    expect(hit?.resetPhrase).toBe("3:45pm");
    expect(hit?.resetAt?.getHours()).toBe(15);
    expect(hit?.resetAt?.getMinutes()).toBe(45);
    expect(hit?.resetAt?.getDate()).toBe(8); // later today
  });

  test("weekly limit with weekday", () => {
    const hit = detectLimitHit("You've hit your weekly limit · resets Mon 12:00am", NOW);
    expect(hit?.kind).toBe("weekly");
    expect(hit?.resetAt?.getDay()).toBe(1); // Monday
    expect(hit?.resetAt?.getHours()).toBe(0);
    expect(hit?.resetAt!.getTime()).toBeGreaterThan(NOW.getTime());
  });

  test("opus limit variant", () => {
    const hit = detectLimitHit("You've hit your Opus limit · resets 3:45pm", NOW);
    expect(hit?.kind).toBe("opus");
  });

  test("no match on normal output", () => {
    expect(detectLimitHit("All tests passed. Session complete.", NOW)).toBeNull();
  });
});

describe("parseResetPhrase", () => {
  test("time already passed today rolls to tomorrow", () => {
    const d = parseResetPhrase("2:00am", NOW)!; // now is 03:00
    expect(d.getDate()).toBe(9);
    expect(d.getHours()).toBe(2);
  });

  test("12am / 12pm handling", () => {
    expect(parseResetPhrase("12:00am", NOW)!.getHours()).toBe(0);
    expect(parseResetPhrase("12:30pm", NOW)!.getHours()).toBe(12);
  });

  test("bare hour without minutes", () => {
    expect(parseResetPhrase("11pm", NOW)!.getHours()).toBe(23);
  });

  test("same weekday with passed time rolls a full week", () => {
    const d = parseResetPhrase("Sat 1:00am", NOW)!; // now is Sat 03:00
    expect(d.getDay()).toBe(6);
    expect(d.getTime() - NOW.getTime()).toBeGreaterThan(6 * 24 * 3600_000);
  });

  test("unrecognized phrase returns null", () => {
    expect(parseResetPhrase("soon", NOW)).toBeNull();
    expect(parseResetPhrase("", NOW)).toBeNull();
  });
});
