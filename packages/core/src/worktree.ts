import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { Config, WorktreeSettings } from "./types.ts";

/**
 * launchd hands the dispatcher a PATH that is not a login shell's — the same
 * trap that made every presence probe read "unknown" until ioreg was spawned
 * absolutely. A post_create script is the user's own shell snippet and will
 * reach for `cp`, `ln`, `direnv`, `mise`; prefixing the usual bin dirs is what
 * keeps it working under launchd and identical to what they tested in a
 * terminal.
 */
const PATH_PREFIX = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The [worktree] settings that apply to one checkout: the top-level values with
 * the per-repo override laid over them.
 *
 * Matching is by resolved path AND by realpath, because a checkout reached
 * through a symlinked parent (~/dev -> /Volumes/…/dev is common) is the same
 * repo the human typed into the config and must not silently miss its override.
 */
export function worktreeSettingsFor(config: Config, repoPath: string): WorktreeSettings {
  const w = config.worktree;
  const base: WorktreeSettings = {
    base: w.base,
    fetch: w.fetch,
    postCreate: w.postCreate,
    postCreateTimeoutSec: w.postCreateTimeoutSec,
  };
  const wanted = path.resolve(repoPath);
  const wantedReal = realpathOr(wanted);
  for (const [key, override] of Object.entries(w.repos)) {
    if (key === wanted || realpathOr(key) === wantedReal) return { ...base, ...override };
  }
  return base;
}

export interface PostCreateResult {
  ok: boolean;
  /** why it failed, for the requeue reason; absent on success */
  reason?: string;
}

/**
 * Run the user's post_create snippet inside the fresh checkout, before the
 * agent starts — it is how git-ignored files (.env, local settings) reach a
 * worktree at all.
 *
 * A non-zero exit is a failure the caller must act on: an agent started on a
 * half-prepared checkout would burn a night's tokens discovering the missing
 * file. Output goes to a log file rather than the dispatcher log because a
 * setup script can be chatty and the reason line is what the human needs.
 */
export async function runPostCreate(opts: {
  script: string;
  timeoutSec: number;
  cwd: string;
  env: Record<string, string>;
  logPath: string;
}): Promise<PostCreateResult> {
  if (opts.script.trim().length === 0) return { ok: true };

  fs.mkdirSync(path.dirname(opts.logPath), { recursive: true });
  const timeoutMs = opts.timeoutSec * 1000;

  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", opts.script], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...opts.env,
        PATH: `${PATH_PREFIX}:${process.env.PATH ?? ""}`,
      },
    });

    let output = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { output += c.toString(); });
    child.stderr.on("data", (c: Buffer) => {
      const s = c.toString();
      output += s;
      stderr += s;
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const finish = (result: PostCreateResult): void => {
      clearTimeout(timer);
      try {
        fs.writeFileSync(opts.logPath, output);
      } catch {
        // the script's own outcome matters more than the transcript of it
      }
      resolve(result);
    };

    const lastErrLine = (): string =>
      stderr.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "no stderr";

    child.on("error", (err) => {
      output += err.message;
      finish({ ok: false, reason: `post_create could not run: ${err.message}` });
    });
    child.on("close", (code) => {
      if (timedOut) return finish({ ok: false, reason: `post_create timed out after ${opts.timeoutSec}s` });
      if (code === 0) return finish({ ok: true });
      finish({ ok: false, reason: `post_create exited ${code}: ${lastErrLine()}` });
    });
  });
}
