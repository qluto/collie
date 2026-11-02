import * as fs from "node:fs";
import * as net from "node:net";
import { spawnSync } from "node:child_process";
import {
  ConfigError, DEFAULT_CONFIG, KEYCHAIN_SERVICE, dispatcherStatePath, ensureDataDirs, hubHome, inputIdleSeconds,
  installCommit, installRoot, installVersion, loadConfig, readApiKey, refreshLimits,
  refreshUpdateCheck, shortSha, updateAvailable, type DispatcherState,
} from "@collie/core";
import { configSectionNotes } from "./update.ts";

function check(label: string, ok: boolean, detail?: string): boolean {
  console.log(`${ok ? "ok " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

/** Worth knowing, never fatal: doctor still exits 0 on these. */
function warn(label: string, detail?: string): void {
  console.log(`warn  ${label}${detail ? ` — ${detail}` : ""}`);
}

function info(label: string, detail?: string): void {
  console.log(`--   ${label}${detail ? ` — ${detail}` : ""}`);
}

async function herdrSocketReachable(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath);
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(2000, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * Boot commit of a LIVE dispatcher; undefined when unknown or the process is
 * gone — a dead one's state file says nothing about what is running.
 */
function readDispatcherCommit(): string | undefined {
  try {
    const state = JSON.parse(fs.readFileSync(dispatcherStatePath(), "utf8")) as DispatcherState;
    process.kill(state.pid, 0); // throws when the pid is gone
    return state.commit;
  } catch {
    return undefined;
  }
}

export async function runDoctor(): Promise<number> {
  ensureDataDirs();
  let allOk = true;
  allOk = check("data dir", fs.existsSync(hubHome()), hubHome()) && allOk;

  let config;
  try {
    config = loadConfig();
    allOk = check("config.toml valid", true) && allOk;
  } catch (err) {
    allOk = check("config.toml valid", false, err instanceof ConfigError ? err.message : String(err)) && allOk;
  }

  // collie's own code: which version, is there a newer one, and is the
  // dispatcher actually running what is on disk. None of it is fatal — an
  // offline origin or a stale dispatcher still dispatches.
  const disk = installCommit();
  info("collie version", `${installVersion() ?? "untagged"} (${shortSha(disk)}) — ${installRoot()}`);
  if (config?.update.check === false) {
    info("update check disabled", "[update] check = false; `collie update --check` still asks");
  } else {
    const upd = await refreshUpdateCheck(config ?? DEFAULT_CONFIG);
    const latest = updateAvailable(upd);
    if (!upd) info("update check", "not run");
    else if (upd.error) warn("update check", upd.error);
    else if (upd.dev) info("update check", `development checkout (${upd.dev}); latest release ${upd.latest ?? "none"}`);
    else if (latest) warn("update available", `${latest} — run \`collie update\``);
    else check("up to date", true, upd.latest ? `latest release ${upd.latest}` : "origin has no release tags yet");
  }
  const dispatcherCommit = readDispatcherCommit();
  if (dispatcherCommit && disk && dispatcherCommit !== disk) {
    warn(
      "dispatcher runs old code",
      `${shortSha(dispatcherCommit)}, checkout is at ${shortSha(disk)} — the launchd job restarts itself within two ticks; otherwise \`collie dispatcher restart\``,
    );
  } else if (dispatcherCommit) {
    check("dispatcher runs the checked-out code", true, shortSha(dispatcherCommit));
  }
  const missing = configSectionNotes();
  if (missing.length > 0) {
    info("config.toml sections not present", `${missing.map((m) => `[${m}]`).join(" ")} — defaults apply; add the section to change them`);
  }

  if (config) {
    const reachable = await herdrSocketReachable(config.herdr.socketPath);
    allOk = check("herdr socket reachable", reachable, config.herdr.socketPath) && allOk;

    // Not fatal: a failed probe means "unknown", which leaves the mode alone.
    const idle = inputIdleSeconds();
    check(
      `presence ${config.presence.enabled ? "enabled" : "disabled"}`,
      true,
      idle === null ? "probe failed" : `input idle ${Math.round(idle)}s`,
    );

    // Only fatal when it is switched on: an enabled importer with no key or no
    // repo mapping silently collects nothing, which looks exactly like an
    // empty backlog.
    if (config.linear.enabled) {
      const key = readApiKey() !== null;
      const repos = Object.keys(config.linear.repos).length;
      allOk = check("linear api key (keychain)", key, key ? undefined : `add it: security add-generic-password -s "${KEYCHAIN_SERVICE}" -a "$USER" -w "lin_api_…"`) && allOk;
      allOk = check("linear repo mapping", repos > 0, repos > 0 ? `${repos} team(s)` : "[linear.repos] is empty — every issue would be skipped") && allOk;
    } else {
      check("linear disabled", true, "collie linear status");
    }
  }

  const claude = spawnSync("claude", ["--version"], { encoding: "utf8" });
  allOk = check("claude on PATH", claude.status === 0, claude.stdout?.trim()) && allOk;

  const ccusage = spawnSync("bunx", ["ccusage", "--version"], { encoding: "utf8", timeout: 30_000 });
  allOk = check("ccusage runnable (bunx)", ccusage.status === 0, ccusage.stdout?.trim() || ccusage.stderr?.trim()?.slice(0, 80)) && allOk;

  // Not fatal: without it the gate falls back to ccusage token estimates.
  const limits = await refreshLimits();
  check(
    "claude usage API (real limit %)",
    limits.snapshot !== null,
    limits.snapshot
      ? `session ${limits.snapshot.sessionPct}%, week ${limits.snapshot.weeklyPct}%`
      : limits.skipped ?? "unavailable",
  );

  return allOk ? 0 : 1;
}
