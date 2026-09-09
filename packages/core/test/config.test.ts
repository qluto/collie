import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseConfig, loadConfig, DEFAULT_CONFIG, DEFAULT_CONFIG_TOML, ConfigError } from "../src/config.ts";
import { configPath, tasksDir } from "../src/paths.ts";

describe("config", () => {
  test("default template parses to expected values", () => {
    const c = parseConfig(DEFAULT_CONFIG_TOML);
    expect(c.dispatch.wipLimit).toBe(2);
    expect(c.dispatch.askingLimit).toBe(3);
    expect(c.schedule.windows).toEqual([{ start: "00:00", end: "07:00", mode: "full" }]);
    expect(c.schedule.defaultMode).toBe("conservative");
    expect(c.quota.sizeEstimateTokens.M).toBe(8_000_000);
    expect(c.herdr.socketPath.endsWith("/.config/herdr/herdr.sock")).toBe(true);
    expect(c.defaults.worktree).toBe(true);
    expect(c.defaults.permissionMode).toBe("auto");
    expect(c.forecast.sessionPctPerTask).toBe(15);
    expect(c.quota.burnDown).toEqual({ enabled: true, windowMin: 90, fraction: 0.95 });
  });

  test("burn_down defaults, overrides and bounds", () => {
    expect(parseConfig("").quota.burnDown).toEqual({ enabled: true, windowMin: 90, fraction: 0.95 });
    const c = parseConfig(`[quota.burn_down]\nenabled = false\nwindow_min = 30\nfraction = 0.99\n`);
    expect(c.quota.burnDown).toEqual({ enabled: false, windowMin: 30, fraction: 0.99 });
    expect(() => parseConfig(`[quota.burn_down]\nwindow_min = 0\n`)).toThrow(ConfigError);
    expect(() => parseConfig(`[quota.burn_down]\nwindow_min = 301\n`)).toThrow(ConfigError);
    expect(() => parseConfig(`[quota.burn_down]\nfraction = 1.5\n`)).toThrow(ConfigError);
    expect(() => parseConfig(`[quota.burn_down]\nenabled = "yes"\n`)).toThrow(ConfigError);
  });

  test("worktree defaults: origin/HEAD, fetched, no script", () => {
    expect(parseConfig(DEFAULT_CONFIG_TOML).worktree).toEqual({
      base: "",
      fetch: true,
      postCreate: "",
      postCreateTimeoutSec: 60,
      repos: {},
    });
    // a config written before this feature existed still gets the whole section
    expect(parseConfig("").worktree).toEqual(DEFAULT_CONFIG.worktree);
  });

  test("worktree overrides, per-repo table and bounds", () => {
    const c = parseConfig(
      `[worktree]\nbase = "develop"\nfetch = false\npost_create = 'cp "$COLLIE_REPO/.env" .env'\n`
      + `post_create_timeout_sec = 10\n`
      + `[worktree.repos."~/dev/projects/myapp"]\nbase = "main"\npost_create_timeout_sec = 5\n`,
    );
    expect(c.worktree.base).toBe("develop");
    expect(c.worktree.fetch).toBe(false);
    expect(c.worktree.postCreate).toBe('cp "$COLLIE_REPO/.env" .env');
    expect(c.worktree.postCreateTimeoutSec).toBe(10);
    // keys are stored expanded + resolved, the same form a task's repo carries
    const key = path.join(os.homedir(), "dev/projects/myapp");
    expect(Object.keys(c.worktree.repos)).toEqual([key]);
    expect(c.worktree.repos[key]).toEqual({ base: "main", postCreateTimeoutSec: 5 });

    expect(() => parseConfig(`[worktree]\npost_create_timeout_sec = 0\n`)).toThrow(ConfigError);
    expect(() => parseConfig(`[worktree]\npost_create_timeout_sec = 3601\n`)).toThrow(ConfigError);
    expect(() => parseConfig(`[worktree]\nfetch = "yes"\n`)).toThrow(ConfigError);
    expect(() => parseConfig(`[worktree]\nbase = 3\n`)).toThrow(ConfigError);
    expect(() => parseConfig(`[worktree]\nrepos = 3\n`)).toThrow(ConfigError);
    expect(() => parseConfig(`[worktree.repos."/x"]\nbase = 3\n`)).toThrow(ConfigError);
  });

  test("presence defaults off, and pauses rather than trickles when it is on", () => {
    expect(parseConfig(DEFAULT_CONFIG_TOML).presence).toEqual({
      enabled: false,
      idleThresholdMin: 20,
      whenPresent: "paused",
      respectOtherAgents: true,
      absentUpgrade: false,
    });
    expect(parseConfig("").presence.enabled).toBe(false);
    const c = parseConfig(
      `[presence]\nenabled = true\nidle_threshold_min = 45\nwhen_present = "paused"\nabsent_upgrade = true\n`,
    );
    expect(c.presence).toEqual({
      enabled: true,
      idleThresholdMin: 45,
      whenPresent: "paused",
      respectOtherAgents: true,
      absentUpgrade: true,
    });
    expect(parseConfig(`[presence]\nwhen_present = "conservative"\n`).presence.whenPresent)
      .toBe("conservative");
    // "full" would be a no-op ceiling; the other bounds keep the probe sane
    expect(() => parseConfig(`[presence]\nwhen_present = "full"\n`)).toThrow(ConfigError);
    expect(() => parseConfig(`[presence]\nidle_threshold_min = 0\n`)).toThrow(ConfigError);
    expect(() => parseConfig(`[presence]\nidle_threshold_min = 481\n`)).toThrow(ConfigError);
    expect(() => parseConfig(`[presence]\nenabled = "yes"\n`)).toThrow(ConfigError);
  });

  test("forecast pct-per-task defaults and stays a usable divisor", () => {
    expect(parseConfig("").forecast.sessionPctPerTask).toBe(15);
    expect(parseConfig(`[forecast]\nsession_pct_per_task = 8\n`).forecast.sessionPctPerTask).toBe(8);
    // 0 would divide the headroom into infinite tasks; >100 is not a percentage
    expect(() => parseConfig(`[forecast]\nsession_pct_per_task = 0\n`)).toThrow(ConfigError);
    expect(() => parseConfig(`[forecast]\nsession_pct_per_task = 101\n`)).toThrow(ConfigError);
  });

  test("permission modes track the claude CLI's choices", () => {
    for (const m of ["auto", "acceptEdits", "plan", "manual", "dontAsk", "bypassPermissions"]) {
      expect(parseConfig(`[defaults]\npermission_mode = "${m}"\n`).defaults.permissionMode).toBe(m as never);
    }
    // legacy alias kept: task files predate the default -> manual rename
    expect(parseConfig(`[defaults]\npermission_mode = "default"\n`).defaults.permissionMode).toBe("default");
    expect(() => parseConfig(`[defaults]\npermission_mode = "yolo"\n`)).toThrow(ConfigError);
  });

  test("defaults.model is claude's own unless named, with the picker's choices", () => {
    const d = parseConfig("");
    expect(d.defaults.model).toBe(""); // "" = pass no --model at all
    expect(d.defaults.modelChoices).toEqual(["sonnet", "opus", "fable"]);

    const set = parseConfig(`[defaults]\nmodel = "fable"\nmodel_choices = ["opus", "fable"]\n`);
    expect(set.defaults.model).toBe("fable");
    expect(set.defaults.modelChoices).toEqual(["opus", "fable"]);

    expect(() => parseConfig(`[defaults]\nmodel = 3\n`)).toThrow(ConfigError);
    expect(() => parseConfig(`[defaults]\nmodel_choices = "opus"\n`)).toThrow(ConfigError);
    expect(() => parseConfig(`[defaults]\nmodel_choices = [" "]\n`)).toThrow(ConfigError);
  });

  test("dispatch.keep_awake defaults on and must be a boolean", () => {
    expect(parseConfig("").dispatch.keepAwake).toBe(true);
    expect(parseConfig(`[dispatch]\nkeep_awake = false\n`).dispatch.keepAwake).toBe(false);
    expect(() => parseConfig(`[dispatch]\nkeep_awake = "yes"\n`)).toThrow(ConfigError);
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
    expect(() => parseConfig(`[dispatch]\nasking_limit = 99\n`)).toThrow(ConfigError);
    // 0 would make `asking >= askingLimit` fire with zero blocked tasks — permanent pause
    expect(() => parseConfig(`[dispatch]\nasking_limit = 0\n`)).toThrow(ConfigError);
    expect(() => parseConfig(`[schedule]\ndefault_mode = "turbo"\n`)).toThrow(ConfigError);
    expect(() => parseConfig(`[[schedule.windows]]\nstart = "25:00"\nend = "07:00"\nmode = "full"\n`)).toThrow(ConfigError);
    expect(() => parseConfig(`not toml [`)).toThrow(ConfigError);
  });
});

describe("first run", () => {
  // Never the real ~/.collie: this describe WRITES config files.
  const freshHome = (create: boolean): string => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "collie-firstrun-")), "collie");
    if (create) fs.mkdirSync(dir, { recursive: true });
    process.env.COLLIE_HOME = dir;
    return dir;
  };

  test("a machine with no ~/.collie at all gets the tree and the default config", () => {
    const home = freshHome(false);
    expect(fs.existsSync(home)).toBe(false);

    const c = loadConfig();

    expect(fs.readFileSync(configPath(), "utf8")).toBe(DEFAULT_CONFIG_TOML);
    expect(fs.existsSync(tasksDir())).toBe(true); // the rest of the tree too
    expect(c.dispatch.wipLimit).toBe(2);
    expect(c.presence.enabled).toBe(false);
  });

  test("an existing config is never overwritten by the template", () => {
    freshHome(true);
    fs.writeFileSync(configPath(), `[dispatch]\nwip_limit = 7\n`);

    expect(loadConfig().dispatch.wipLimit).toBe(7);
    expect(fs.readFileSync(configPath(), "utf8")).toBe(`[dispatch]\nwip_limit = 7\n`);
    // a file that predates a feature keeps working: the missing keys default
    expect(loadConfig().presence.enabled).toBe(false);
    expect(loadConfig().quota.burnDown.enabled).toBe(true);
  });
});

// A config written before a feature existed never grows its section — every
// key has to survive total absence. Linear is the newest section and the one
// that reaches a third-party API, so "absent" must mean "off", not "default
// something and start calling out".
describe("a config that predates a feature", () => {
  test("no [linear] section at all still parses, switched off", () => {
    const c = parseConfig(`[dispatch]\nwip_limit = 2\n`);
    expect(c.linear.enabled).toBe(false);
    expect(c.linear.label).toBe(DEFAULT_CONFIG.linear.label);
    expect(c.linear.repos).toEqual({});
    expect(c.linear.pollIntervalMin).toBe(DEFAULT_CONFIG.linear.pollIntervalMin);
  });

  test("an empty file is the full defaults, not a crash", () => {
    expect(parseConfig("")).toEqual(DEFAULT_CONFIG);
  });
});
