import * as fs from "node:fs";
import * as net from "node:net";
import { spawnSync } from "node:child_process";
import { ConfigError, ensureDataDirs, hubHome, loadConfig } from "@collie/core";

function check(label: string, ok: boolean, detail?: string): boolean {
  console.log(`${ok ? "ok " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
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

  if (config) {
    const reachable = await herdrSocketReachable(config.herdr.socketPath);
    allOk = check("herdr socket reachable", reachable, config.herdr.socketPath) && allOk;
  }

  const claude = spawnSync("claude", ["--version"], { encoding: "utf8" });
  allOk = check("claude on PATH", claude.status === 0, claude.stdout?.trim()) && allOk;

  const ccusage = spawnSync("bunx", ["ccusage", "--version"], { encoding: "utf8", timeout: 30_000 });
  allOk = check("ccusage runnable (bunx)", ccusage.status === 0, ccusage.stdout?.trim() || ccusage.stderr?.trim()?.slice(0, 80)) && allOk;

  return allOk ? 0 : 1;
}
