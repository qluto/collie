import { describe, expect, test } from "bun:test";
import { parseConfig, DEFAULT_CONFIG_TOML, ConfigError } from "../src/config.ts";

describe("config", () => {
  test("default template parses to expected values", () => {
    const c = parseConfig(DEFAULT_CONFIG_TOML);
    expect(c.dispatch.wipLimit).toBe(2);
    expect(c.schedule.windows).toEqual([{ start: "00:00", end: "07:00", mode: "full" }]);
    expect(c.schedule.defaultMode).toBe("conservative");
    expect(c.quota.sizeEstimateTokens.M).toBe(8_000_000);
    expect(c.herdr.socketPath.endsWith("/.config/herdr/herdr.sock")).toBe(true);
    expect(c.defaults.worktree).toBe(true);
    expect(c.defaults.permissionMode).toBe("auto");
  });

  test("permission modes track the claude CLI's choices", () => {
    for (const m of ["auto", "acceptEdits", "plan", "manual", "dontAsk", "bypassPermissions"]) {
      expect(parseConfig(`[defaults]\npermission_mode = "${m}"\n`).defaults.permissionMode).toBe(m as never);
    }
    // legacy alias kept: task files predate the default -> manual rename
    expect(parseConfig(`[defaults]\npermission_mode = "default"\n`).defaults.permissionMode).toBe("default");
    expect(() => parseConfig(`[defaults]\npermission_mode = "yolo"\n`)).toThrow(ConfigError);
  });

  test("empty file yields defaults", () => {
    const c = parseConfig("");
    expect(c.dispatch.wipLimit).toBe(2);
    expect(c.quota.fractionFull).toBe(0.85);
  });

  test("partial override keeps other defaults", () => {
    const c = parseConfig(`[dispatch]\nwip_limit = 3\n`);
    expect(c.dispatch.wipLimit).toBe(3);
    expect(c.dispatch.pollIntervalSec).toBe(30);
  });

  test("invalid values rejected", () => {
    expect(() => parseConfig(`[dispatch]\nwip_limit = 0\n`)).toThrow(ConfigError);
    expect(() => parseConfig(`[schedule]\ndefault_mode = "turbo"\n`)).toThrow(ConfigError);
    expect(() => parseConfig(`[[schedule.windows]]\nstart = "25:00"\nend = "07:00"\nmode = "full"\n`)).toThrow(ConfigError);
    expect(() => parseConfig(`not toml [`)).toThrow(ConfigError);
  });
});
