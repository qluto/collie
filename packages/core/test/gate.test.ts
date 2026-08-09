import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  effectiveSessionFraction, limitsAllow, modeAdmits, quotaAllows, sizeFits, type UsageSnapshot,
} from "../src/quota/gate.ts";
import { clearUsageCache, getUsage } from "../src/quota/ccusage.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { LimitSnapshot } from "../src/quota/limits-api.ts";

const quota = DEFAULT_CONFIG.quota; // block 60M, week 800M, frac .85/.35, S/M/L = 2/8/20M

const snap = (block: number, week = 0, ok = true): UsageSnapshot => ({
  blockUsedTokens: block,
  weekUsedTokens: week,
  ok,
  fetchedAt: Date.now(),
});

describe("quotaAllows", () => {
  test("allows under budget in full mode", () => {
    // cap = 60M * 0.85 = 51M; 40M + 8M <= 51M
    expect(quotaAllows(quota, "full", "M", snap(40e6)).allow).toBe(true);
  });

  test("denies when block estimate would exceed the capped budget", () => {
    // 45M + 8M > 51M
    const d = quotaAllows(quota, "full", "M", snap(45e6));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("blocked by quota");
  });

  test("conservative fraction is much tighter", () => {
    // cap = 60M * 0.35 = 21M; 15M + 8M > 21M
    expect(quotaAllows(quota, "conservative", "M", snap(15e6)).allow).toBe(false);
    expect(quotaAllows(quota, "conservative", "S", snap(15e6)).allow).toBe(true);
  });

  test("weekly cap denies independently of block", () => {
    // week cap = 800M * 0.9 = 720M
    const d = quotaAllows(quota, "full", "M", snap(0, 715e6));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("weekly");
  });

  test("ccusage failure: deny in conservative, allow in full", () => {
    expect(quotaAllows(quota, "conservative", "S", snap(0, 0, false)).allow).toBe(false);
    expect(quotaAllows(quota, "full", "S", snap(0, 0, false)).allow).toBe(true);
  });
});

describe("sizeFits", () => {
  test("ordering", () => {
    expect(sizeFits("S", "M")).toBe(true);
    expect(sizeFits("M", "M")).toBe(true);
    expect(sizeFits("L", "M")).toBe(false);
  });
});

describe("modeAdmits", () => {
  const cap = quota.conservativeMaxSize; // "M"

  test("full takes everything, including oversized", () => {
    expect(modeAdmits({ size: "L" }, "full", cap)).toBe(true);
  });

  test("paused takes nothing", () => {
    expect(modeAdmits({ size: "S" }, "paused", cap)).toBe(false);
  });

  test("conservative applies the size cap", () => {
    expect(modeAdmits({ size: "S" }, "conservative", cap)).toBe(true);
    expect(modeAdmits({ size: "M" }, "conservative", cap)).toBe(true);
    expect(modeAdmits({ size: "L" }, "conservative", cap)).toBe(false);
  });
});

describe("effectiveSessionFraction", () => {
  const NOW = Date.UTC(2026, 0, 15, 22, 0, 0);
  const inMin = (m: number) => ({ sessionResetsAt: new Date(NOW + m * 60_000).toISOString() });

  test("full mode inside the burn window spends the relaxed fraction", () => {
    expect(effectiveSessionFraction(quota, "full", inMin(60), NOW)).toEqual({ frac: 0.95, burning: true });
  });

  test("outside the window the standing cap holds", () => {
    expect(effectiveSessionFraction(quota, "full", inMin(200), NOW)).toEqual({ frac: 0.85, burning: false });
  });

  test("conservative never burns, even inside the window", () => {
    expect(effectiveSessionFraction(quota, "conservative", inMin(60), NOW)).toEqual({ frac: 0.35, burning: false });
  });

  test("disabled burn_down keeps the standing cap", () => {
    const off = { ...quota, burnDown: { ...quota.burnDown, enabled: false } };
    expect(effectiveSessionFraction(off, "full", inMin(60), NOW)).toEqual({ frac: 0.85, burning: false });
  });

  test("no usable reset time means we cannot know what is about to evaporate", () => {
    for (const sessionResetsAt of [undefined, "", "soon-ish"]) {
      expect(effectiveSessionFraction(quota, "full", { sessionResetsAt }, NOW))
        .toEqual({ frac: 0.85, burning: false });
    }
  });

  test("a reset already past does not burn", () => {
    expect(effectiveSessionFraction(quota, "full", inMin(-5), NOW)).toEqual({ frac: 0.85, burning: false });
  });

  test("a fraction below the standing cap never tightens it", () => {
    const low = { ...quota, burnDown: { ...quota.burnDown, fraction: 0.5 } };
    expect(effectiveSessionFraction(low, "full", inMin(10), NOW)).toEqual({ frac: 0.85, burning: true });
  });
});

describe("limitsAllow", () => {
  const NOW = Date.UTC(2026, 0, 15, 22, 0, 0);
  const limits = (over: Partial<LimitSnapshot> = {}): LimitSnapshot => ({
    sessionPct: 88,
    weeklyPct: 10,
    fetchedAt: NOW,
    ...over,
  });
  const resetIn = (m: number) => new Date(NOW + m * 60_000).toISOString();

  test("88% is over the standing 85% cap", () => {
    const d = limitsAllow(quota, "full", limits({ sessionResetsAt: resetIn(200) }), NOW);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("blocked by session limit");
    expect(d.reason).not.toContain("burn-down");
  });

  test("the same 88% is spendable inside the burn window", () => {
    const d = limitsAllow(quota, "full", limits({ sessionResetsAt: resetIn(30) }), NOW);
    expect(d.allow).toBe(true);
    expect(d.reason).toContain("88%/95%");
    expect(d.reason).toContain("burn-down");
  });

  test("past even the relaxed cap the deny reason says why it was relaxed", () => {
    const d = limitsAllow(quota, "full", limits({ sessionPct: 96, sessionResetsAt: resetIn(30) }), NOW);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("cap 95%");
    expect(d.reason).toContain("burn-down");
  });

  test("the weekly cap is untouched by burn-down", () => {
    const d = limitsAllow(quota, "full", limits({ sessionPct: 10, weeklyPct: 91, sessionResetsAt: resetIn(30) }), NOW);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("blocked by weekly limit");
  });
});

describe("getUsage with fixture script", () => {
  test("parses active block and weekly sum; caches", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccusage-fixture-"));
    const script = path.join(dir, "fake-ccusage.sh");
    fs.writeFileSync(
      script,
      `#!/bin/sh
case "$1" in
  blocks) echo '{"blocks":[{"isActive":false,"isGap":true,"totalTokens":1},{"isActive":true,"totalTokens":12345678,"endTime":"2026-08-08T10:00:00.000Z"}]}' ;;
  daily)  echo '{"daily":[{"date":"2026-08-07","totalTokens":100000000},{"date":"2026-08-08","totalTokens":50000000}]}' ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.COLLIE_CCUSAGE_BIN = script;
    clearUsageCache();
    const u = getUsage();
    expect(u.ok).toBe(true);
    expect(u.blockUsedTokens).toBe(12_345_678);
    expect(u.weekUsedTokens).toBe(150_000_000);
    expect(u.blockEndsAt).toBe("2026-08-08T10:00:00.000Z");
    delete process.env.COLLIE_CCUSAGE_BIN;
    clearUsageCache();
  });

  test("failure yields ok=false snapshot", () => {
    process.env.COLLIE_CCUSAGE_BIN = "/nonexistent/ccusage";
    clearUsageCache();
    const u = getUsage();
    expect(u.ok).toBe(false);
    delete process.env.COLLIE_CCUSAGE_BIN;
    clearUsageCache();
  });
});
