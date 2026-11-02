import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_CONFIG, changelogSections, configPath, installCommit, installGit, installGitRemote,
  installRoot, installVersion, latestReleaseTag, listTasks, loadConfig, missingConfigSections,
  refreshUpdateCheck, shortSha, updateAvailable, type Config, type UpdateCheck,
} from "@collie/core";
import { plistDest, restartLaunchd } from "./dispatcher.ts";

/**
 * Why `collie update` must not run right now, or null. Pure: the command
 * gathers the facts, this decides.
 *
 * - tracked changes: a merge would carry them along or refuse half-way; either
 *   way the human's edits are in the blast radius
 * - not the default branch: that checkout is someone's work in progress, and
 *   fast-forwarding it to a release tag is not what they asked for
 * - running tasks: their hooks call `collie hook …` from source on every
 *   event, so a session started on the old code would finish on the new one
 */
export function refuseUpdate(input: {
  trackedChanges: string[];
  branch: string | null;
  defaultBranch: string | null;
  running: string[];
  now: boolean;
}): string | null {
  if (input.trackedChanges.length > 0) {
    return `the collie checkout has uncommitted changes (${input.trackedChanges.length} file(s)) — commit or stash them first`;
  }
  if (!input.defaultBranch) {
    return "cannot tell the checkout's default branch (origin/HEAD is unset) — run `git remote set-head origin --auto` in it";
  }
  if (input.branch !== input.defaultBranch) {
    return `the collie checkout is on ${input.branch && input.branch !== "HEAD" ? input.branch : "a detached HEAD"}, not ${input.defaultBranch} — switch back to update`;
  }
  if (input.running.length > 0 && !input.now) {
    return `${input.running.length} task(s) running (${input.running.join(", ")}): their sessions' hooks would switch to the new code mid-run. Wait for them, or pass --now`;
  }
  return null;
}

export type UpdatePlan =
  | { action: "none"; message: string }
  | { action: "merge"; target: string };

/** Given the newest release and whether HEAD already has it, what to do. */
export function planUpdate(input: {
  current: string | null;
  target: string | null;
  headContainsTarget: boolean;
}): UpdatePlan {
  if (!input.target) return { action: "none", message: "origin has no release tags (vX.Y.Z) yet — nothing to update to" };
  if (input.headContainsTarget) {
    return { action: "none", message: `already up to date (${input.current ?? input.target}; latest release ${input.target})` };
  }
  return { action: "merge", target: input.target };
}

export interface UpdateDeps {
  /** launchd plist; absent file = no launchd job to restart */
  plistPath?: string;
  restart?: () => number;
  /** dependency install after bun.lock moved; returns an exit code */
  install?: (root: string) => number;
}

function bunInstall(root: string): number {
  // process.execPath: the bun running us — a pane or launchd has no reliable PATH
  const res = spawnSync(process.execPath, ["install"], { cwd: root, stdio: "inherit" });
  return res.status ?? 1;
}

function loadConfigOrDefault(): Config {
  try {
    return loadConfig();
  } catch {
    return DEFAULT_CONFIG; // doctor is where a broken config.toml gets reported
  }
}

function printCheck(check: UpdateCheck): void {
  console.log(`collie ${check.current ?? "(untagged)"} at ${shortSha(check.commit)} — ${installRoot()}`);
  console.log(`latest release on origin: ${check.latest ?? "none"} (checked ${check.checkedAt})`);
  if (check.error) console.log(`check failed: ${check.error}`);
  const latest = updateAvailable(check);
  if (check.dev) console.log(`development checkout (${check.dev}) — update notices are off here`);
  else if (latest) console.log(`update available: ${latest} — run \`collie update\``);
  else if (check.latest) console.log("up to date");
}

/**
 * Sections a pre-existing config.toml lacks. Shared with doctor: loadConfig
 * never adds them, so this is the only place a user hears about them.
 */
export function configSectionNotes(): string[] {
  let toml: string;
  try {
    toml = fs.readFileSync(configPath(), "utf8");
  } catch {
    return []; // no file yet: the first loadConfig writes the full template
  }
  return missingConfigSections(toml);
}

export async function runUpdateCommand(argv: string[], deps: UpdateDeps = {}): Promise<number> {
  let values: { check?: boolean; now?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { check: { type: "boolean", default: false }, now: { type: "boolean", default: false } },
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\nusage: collie update [--check] [--now]`);
    return 2;
  }
  const config = loadConfigOrDefault();

  if (values.check) {
    // forced: a human asking "is there an update" wants origin's answer now
    const check = await refreshUpdateCheck(config, { force: true });
    if (check) printCheck(check);
    return 0;
  }

  const root = installRoot();
  const status = installGit(["status", "--porcelain", "--untracked-files=no"], root);
  const branch = installGit(["rev-parse", "--abbrev-ref", "HEAD"], root);
  const def = installGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root);
  const refusal = refuseUpdate({
    trackedChanges: status.ok ? status.out.split("\n").filter(Boolean) : [],
    branch: branch.ok ? branch.out : null,
    defaultBranch: def.ok && def.out ? def.out.replace(/^origin\//, "") : null,
    running: listTasks({ status: ["running"] }).map((t) => t.id),
    now: values.now ?? false,
  });
  if (refusal) {
    console.error(`collie update: ${refusal}`);
    return 1;
  }

  console.log(`fetching release tags from origin (${root}) …`);
  const fetched = await installGitRemote(["fetch", "--tags", "origin"], 120_000, root);
  if (!fetched.ok) {
    console.error(`collie update: git fetch failed: ${fetched.err.split("\n")[0] ?? "unknown error"}`);
    return 1;
  }
  const tags = installGit(["for-each-ref", "refs/tags", "--format=%(objectname)\t%(refname)"], root);
  const target = tags.ok ? latestReleaseTag(tags.out) : null;
  const oldHead = installCommit(root);
  const oldVersion = installVersion(root);
  const contains = target ? installGit(["merge-base", "--is-ancestor", target, "HEAD"], root).ok : false;
  const plan = planUpdate({ current: oldVersion, target, headContainsTarget: contains });
  if (plan.action === "none") {
    console.log(plan.message);
    await refreshUpdateCheck(config);
    return 0;
  }

  const merged = installGit(["merge", "--ff-only", plan.target], root);
  if (!merged.ok) {
    console.error(
      `collie update: cannot fast-forward ${shortSha(oldHead)} to ${plan.target} — the checkout has commits the release does not.\n` +
      `  ${merged.err.split("\n")[0] ?? ""}\n  Resolve it by hand in ${root} (nothing was changed).`,
    );
    return 1;
  }
  const newHead = installCommit(root);
  console.log(`updated ${oldVersion ?? "(untagged)"} (${shortSha(oldHead)}) → ${plan.target} (${shortSha(newHead)})`);

  let exit = 0;
  // `git diff --quiet` exits 1 when the file differs
  const lockMoved = oldHead && newHead
    ? !installGit(["diff", "--quiet", oldHead, newHead, "--", "bun.lock"], root).ok
    : true;
  if (lockMoved) {
    console.log("bun.lock changed — installing dependencies …");
    if ((deps.install ?? bunInstall)(root) !== 0) {
      console.error(`bun install failed — run it by hand in ${root} before relying on the new code`);
      exit = 1;
    }
  }

  if (fs.existsSync(deps.plistPath ?? plistDest())) {
    // The launchd job would also notice the new HEAD and restart itself within
    // two ticks; doing it here means the new code runs now, not in a minute.
    (deps.restart ?? restartLaunchd)();
  } else {
    console.log("no launchd dispatcher installed — restart a manually run dispatcher yourself");
  }
  console.log("an open `collie tui` keeps the old code until you quit and reopen it");

  await refreshUpdateCheck(config);

  try {
    const md = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    const sections = changelogSections(md, oldVersion, plan.target);
    if (sections.length > 0) {
      console.log("\n── what changed ──\n");
      for (const s of sections) console.log(`${s.text}\n`);
    }
  } catch {
    // no changelog in this release: the tag message and git log still are
  }

  const missing = configSectionNotes();
  if (missing.length > 0) {
    console.log(`config.toml has no ${missing.map((m) => `[${m}]`).join(" ")} — defaults apply; add the section to change them`);
  }
  console.log("run `collie doctor` to check the rest");
  return exit;
}
