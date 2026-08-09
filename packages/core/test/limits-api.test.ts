import { describe, expect, test, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LIMITS_TTL_MS, parseLimits, readLimits } from "../src/quota/limits-api.ts";
import { limitsStatePath } from "../src/paths.ts";
import { limitsAllow } from "../src/quota/gate.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

// Trimmed capture of a real GET /api/oauth/usage response. The top-level keys
// alongside `limits` are internal codenames; the parser must ignore them.
const BODY = {
  five_hour: { utilization: 32.0, resets_at: "2026-08-09T02:00:00Z" },
  seven_day: { utilization: 4.0 },
  tangelo: null,
  iguana_necktie: null,
  nimbus_quill: { utilization: 0.0 },
  limits: [
    { kind: "session", group: "session", percent: 32, resets_at: "2026-08-09T02:00:00Z", is_active: true },
    { kind: "weekly_all", group: "weekly", percent: 4, is_active: false },
    { kind: "weekly_scoped", group: "weekly", percent: 11, scope: { model: { display_name: "Fable" } } },
  ],
};

beforeEach(() => {
  process.env.COLLIE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "collie-limits-"));
});

describe("parseLimits", () => {
  test("reads session and the worst weekly scope", () => {
    const snap = parseLimits(BODY, 1000)!;
    expect(snap.sessionPct).toBe(32);
    expect(snap.weeklyPct).toBe(11); // scoped 11% beats weekly_all 4%
    expect(snap.sessionResetsAt).toBe("2026-08-09T02:00:00Z");
  });

  test("returns null when limits[] is absent or empty — never a false 0%", () => {
    expect(parseLimits({ five_hour: { utilization: 32 } }, 1)).toBeNull();
    expect(parseLimits({ limits: [] }, 1)).toBeNull();
    expect(parseLimits(null, 1)).toBeNull();
  });
});

describe("readLimits cache", () => {
  test("returns a fresh snapshot and rejects a stale one", () => {
    const now = Date.now();
    fs.writeFileSync(limitsStatePath(), JSON.stringify({ sessionPct: 30, weeklyPct: 4, fetchedAt: now }));
    expect(readLimits(now + LIMITS_TTL_MS)!.sessionPct).toBe(30); // past the TTL but still usable
    expect(readLimits(now + 41 * 60_000)).toBeNull(); // past the max age -> fall back to ccusage
  });

  test("missing or corrupt cache is not an error", () => {
    expect(readLimits()).toBeNull();
    fs.writeFileSync(limitsStatePath(), "{not json");
    expect(readLimits()).toBeNull();
  });
});

describe("limitsAllow", () => {
  const quota = DEFAULT_CONFIG.quota; // fractions .85 full / .35 conservative, week .9
  const snap = (sessionPct: number, weeklyPct = 0) => ({ sessionPct, weeklyPct, fetchedAt: Date.now() });

  test("session cap differs by mode", () => {
    expect(limitsAllow(quota, "full", snap(80)).allow).toBe(true);
    expect(limitsAllow(quota, "full", snap(85)).allow).toBe(false);
    expect(limitsAllow(quota, "conservative", snap(30)).allow).toBe(true);
    expect(limitsAllow(quota, "conservative", snap(35)).allow).toBe(false);
  });

  test("weekly cap applies in both modes", () => {
    const d = limitsAllow(quota, "full", snap(1, 90));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("weekly");
  });

  test("the reason states the measurement age, since it can be 10min old", () => {
    expect(limitsAllow(quota, "full", snap(10)).reason).toContain("measured");
  });
});
