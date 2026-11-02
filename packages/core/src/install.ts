import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { GitResult } from "./git.ts";

/**
 * The launchd label the dispatcher runs under. Lives in core because two sides
 * need it: the CLI that installs the plist, and the dispatcher deciding whether
 * it is the launchd job (env XPC_SERVICE_NAME carries the label there) and may
 * therefore exit to pick up new code — KeepAlive brings it back.
 */
export const DISPATCHER_LABEL = "com.qluto.collie.dispatcher";

/**
 * The collie checkout this code was loaded from (core/src -> repo root).
 * collie is installed as "git clone + run from source", so this directory IS
 * the installation: its HEAD is the version, its origin is where updates come
 * from. COLLIE_INSTALL_ROOT points it at a sandbox clone for tests.
 */
export function installRoot(): string {
  const env = process.env.COLLIE_INSTALL_ROOT;
  return env && env.length > 0 ? env : path.resolve(import.meta.dir, "..", "..", "..");
}

/**
 * git, absolutely: the dispatcher runs under launchd, and any subprocess it
 * spawns by bare name inherits the PATH trap that hid ioreg for a week.
 * COLLIE_GIT_BIN overrides it for tests.
 */
export function gitBin(): string {
  const override = process.env.COLLIE_GIT_BIN;
  if (override) return override;
  return fs.existsSync("/usr/bin/git") ? "/usr/bin/git" : "git";
}

/** Local, quick git against the installation (15s ceiling). Never throws. */
export function installGit(args: string[], root = installRoot()): GitResult {
  try {
    const res = spawnSync(gitBin(), ["-C", root, ...args], { encoding: "utf8", timeout: 15_000 });
    return { ok: res.status === 0, out: (res.stdout ?? "").trim(), err: (res.stderr ?? "").trim() };
  } catch (err) {
    return { ok: false, out: "", err: (err as Error).message };
  }
}

/**
 * Network git against the installation. Never prompts — a dispatcher at 3am
 * has nobody to type a passphrase — and never throws; a timeout is a failed
 * result like any other.
 */
export function installGitRemote(args: string[], timeoutMs = 30_000, root = installRoot()): Promise<GitResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(gitBin(), ["-C", root, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
      });
    } catch (err) {
      resolve({ ok: false, out: "", err: (err as Error).message });
      return;
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { err += c.toString(); });
    const timer = setTimeout(() => {
      err += `\ntimed out after ${Math.round(timeoutMs / 1000)}s`;
      child.kill("SIGKILL");
    }, timeoutMs);
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, out: out.trim(), err: err.trim() });
    };
    child.on("error", (e) => { err += e.message; done(false); });
    child.on("close", (code) => done(code === 0));
  });
}

/** The commit the installation's checkout sits on right now (on disk). */
export function installCommit(root = installRoot()): string | null {
  const res = installGit(["rev-parse", "HEAD"], root);
  return res.ok && res.out ? res.out : null;
}

/** Nearest release tag reachable from HEAD; null for an untagged history. */
export function installVersion(root = installRoot()): string | null {
  const res = installGit(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"], root);
  return res.ok && res.out ? res.out : null;
}

export const shortSha = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : "unknown");

export type DriftDecision =
  | { action: "none" }
  /** code changed, but this is the first tick that saw it: let a pull settle */
  | { action: "wait"; from: string; to: string }
  /** launchd job, change stable for a tick: exit and let KeepAlive restart us */
  | { action: "restart"; from: string; to: string }
  /** not launchd's job (manual run): nobody would bring us back, so only say it */
  | { action: "report"; from: string; to: string };

/**
 * Whether a running dispatcher should restart onto new code. It loads its
 * modules once; hooks and the CLI load fresh source per call, so after a
 * `git pull` the two silently disagree until something restarts it.
 *
 * Restart only when the same new HEAD was seen on the PREVIOUS tick too: a
 * `git pull` followed by `bun install` is several steps, and restarting into
 * the middle of them would boot a half-updated tree. Unknown commits (git
 * unavailable) never restart anything.
 */
export function decideDrift(input: {
  bootCommit: string | null;
  diskCommit: string | null;
  previousDiskCommit: string | null;
  underLaunchd: boolean;
}): DriftDecision {
  const { bootCommit: from, diskCommit: to } = input;
  if (!from || !to || from === to) return { action: "none" };
  if (!input.underLaunchd) return { action: "report", from, to };
  if (input.previousDiskCommit !== to) return { action: "wait", from, to };
  return { action: "restart", from, to };
}

/** True inside the launchd job (launchd sets XPC_SERVICE_NAME to the label). */
export function underLaunchd(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.XPC_SERVICE_NAME === DISPATCHER_LABEL;
}
