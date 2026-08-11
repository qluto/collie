import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { applyPresence, inputIdleSeconds, parseHidIdleNs, type PresenceSignals } from "../src/presence.ts";
import type { Config, ScheduleMode } from "../src/types.ts";

/** Trimmed from real `ioreg -c IOHIDSystem -d 4` output on macOS 15. */
const IOREG = `+-o Root  <class IORegistryEntry, id 0x100000100, retain 39>
  +-o MacBookPro18,3  <class IOPlatformExpertDevice, id 0x100000268, retain 44>
    +-o IOHIDSystem  <class IOHIDSystem, id 0x1000004f2, registered, retain 8>
      | {
      |   "IOClass" = "IOHIDSystem"
      |   "IOReportLegendPublic" = Yes
      |   "IOProbeScore" = 0
      |   "HIDIdleTime" = 3190655804708
      |   "HIDScrollCountIgnoreMomentumScrolls" = Yes
      |   "HIDScrollCountAccelerationFactor" = 163840
      | }
`;

/** Enabled, and capping at conservative unless a test says otherwise. */
function cfg(over: Partial<Config["presence"]> = {}): Config["presence"] {
  return { ...DEFAULT_CONFIG.presence, enabled: true, whenPresent: "conservative", ...over };
}

function signals(idleSec: number | null, othersWorking = false): PresenceSignals {
  return { idleSec, othersWorking };
}

const MIN = 60;

describe("parseHidIdleNs", () => {
  test("pulls the nanosecond counter out of a real ioreg dump", () => {
    expect(parseHidIdleNs(IOREG)).toBe(3_190_655_804_708);
    expect(parseHidIdleNs(IOREG)! / 1e9).toBeCloseTo(3190.66, 1);
  });

  test("null when the key is absent or the output is garbage", () => {
    expect(parseHidIdleNs(IOREG.replace(/"HIDIdleTime" = \d+/, `"IOMatchCategory" = "x"`))).toBeNull();
    expect(parseHidIdleNs("")).toBeNull();
    expect(parseHidIdleNs("ioreg: not found\n")).toBeNull();
    expect(parseHidIdleNs(`"HIDIdleTime" = <ptr>`)).toBeNull();
  });
});

describe("inputIdleSeconds", () => {
  // launchd hands the dispatcher a PATH without /usr/sbin, where ioreg lives.
  // The bare name resolved to ENOENT there and every human at the keyboard read
  // as "unknown", while doctor — run from a login shell — said the probe was
  // fine. An empty PATH is that condition, exaggerated.
  test.skipIf(process.platform !== "darwin")("survives an empty PATH", () => {
    const saved = process.env.PATH;
    process.env.PATH = "";
    try {
      expect(inputIdleSeconds()).not.toBeNull();
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe("applyPresence", () => {
  test("disabled is a pure passthrough", () => {
    for (const mode of ["full", "conservative", "paused"] as ScheduleMode[]) {
      const r = applyPresence(mode, signals(5, true), cfg({ enabled: false, absentUpgrade: true }));
      expect(r).toEqual({ mode });
    }
  });

  test("paused is never upgraded, even by a long-absent machine", () => {
    const r = applyPresence("paused", signals(600 * MIN), cfg({ absentUpgrade: true }));
    expect(r).toEqual({ mode: "paused" });
  });

  test("a human at the keyboard downgrades full", () => {
    const r = applyPresence("full", signals(3 * MIN), cfg());
    expect(r.mode).toBe("conservative");
    expect(r.reason).toMatch(/presence: human at keyboard/);
  });

  test("when_present = paused is honored", () => {
    const r = applyPresence("full", signals(3 * MIN), cfg({ whenPresent: "paused" }));
    expect(r.mode).toBe("paused");
    expect(r.reason).toMatch(/→ paused/);
  });

  test("idle past the threshold is not presence", () => {
    expect(applyPresence("full", signals(30 * MIN), cfg())).toEqual({ mode: "full" });
  });

  // The bug this ladder replaced: capping only `full` left presence inert
  // every daytime hour, which is when there is a human to respect.
  test("when_present = paused also pauses a conservative window", () => {
    const r = applyPresence("conservative", signals(3 * MIN), cfg({ whenPresent: "paused" }));
    expect(r.mode).toBe("paused");
    expect(r.reason).toBe("presence: human at keyboard → paused");
  });

  test("a cap that does not bind leaves the mode alone but still says so", () => {
    const r = applyPresence("conservative", signals(3 * MIN), cfg());
    expect(r.mode).toBe("conservative");
    expect(r.reason).toBe("presence: human at keyboard (already conservative)");
  });

  test("presence never raises a mode, whatever when_present says", () => {
    for (const whenPresent of ["conservative", "paused"] as const) {
      for (const mode of ["full", "conservative", "paused"] as ScheduleMode[]) {
        const r = applyPresence(mode, signals(1 * MIN), cfg({ whenPresent }));
        expect(["full", "conservative", "paused"].indexOf(r.mode))
          .toBeGreaterThanOrEqual(["full", "conservative", "paused"].indexOf(mode));
      }
    }
  });

  test("another working agent counts as presence even with no idle reading", () => {
    const r = applyPresence("full", signals(null, true), cfg());
    expect(r.mode).toBe("conservative");
    expect(r.reason).toMatch(/another agent working/);
  });

  test("respect_other_agents = false ignores them", () => {
    const r = applyPresence("full", signals(null, true), cfg({ respectOtherAgents: false }));
    expect(r.mode).toBe("full");
  });

  test("absent + absent_upgrade lifts conservative to full", () => {
    const r = applyPresence("conservative", signals(34 * MIN), cfg({ absentUpgrade: true }));
    expect(r.mode).toBe("full");
    expect(r.reason).toBe("presence: idle 34m → full");
  });

  test("absent without absent_upgrade changes nothing", () => {
    expect(applyPresence("conservative", signals(34 * MIN), cfg())).toEqual({ mode: "conservative" });
  });

  test("a working agent blocks the upgrade even when the keyboard is cold", () => {
    const r = applyPresence("conservative", signals(34 * MIN, true), cfg({ absentUpgrade: true }));
    expect(r.mode).toBe("conservative");
    expect(r.reason).toBe("presence: another agent working (already conservative)");
  });

  test("a failed probe never upgrades", () => {
    expect(applyPresence("conservative", signals(null), cfg({ absentUpgrade: true })).mode)
      .toBe("conservative");
    expect(applyPresence("full", signals(null), cfg()).mode).toBe("full");
  });

  // Silent inertness is what hid a PATH-less ioreg for a whole week: the
  // dispatcher dispatched at a human and its decision line looked like a
  // window verdict, indistinguishable from presence being switched off.
  test("a failed probe announces itself instead of passing silently", () => {
    expect(applyPresence("full", signals(null), cfg()).reason)
      .toBe("presence: input probe unavailable");
  });
});
