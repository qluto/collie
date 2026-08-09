import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { applyPresence, parseHidIdleNs, type PresenceSignals } from "../src/presence.ts";
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

function cfg(over: Partial<Config["presence"]> = {}): Config["presence"] {
  return { ...DEFAULT_CONFIG.presence, enabled: true, ...over };
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

  test("another working agent counts as presence even with no idle reading", () => {
    const r = applyPresence("full", signals(null, true), cfg());
    expect(r.mode).toBe("conservative");
    expect(r.reason).toMatch(/another agent working/);
  });

  test("respect_other_agents = false ignores them", () => {
    const r = applyPresence("full", signals(null, true), cfg({ respectOtherAgents: false }));
    expect(r).toEqual({ mode: "full" });
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
    expect(r).toEqual({ mode: "conservative" });
  });

  test("a failed probe never upgrades", () => {
    expect(applyPresence("conservative", signals(null), cfg({ absentUpgrade: true })))
      .toEqual({ mode: "conservative" });
    expect(applyPresence("full", signals(null), cfg())).toEqual({ mode: "full" });
  });
});
