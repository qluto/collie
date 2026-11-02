import * as fs from "node:fs";
import { ensureDataDirs, updateStatePath } from "./paths.ts";
import { installCommit, installGit, installGitRemote, installRoot, installVersion } from "./install.ts";
import type { Config } from "./types.ts";

/**
 * "Is there a newer collie?" — answered from the installation's own git origin.
 *
 * Split like linear/plan.ts vs api.ts: everything that DECIDES (which tags are
 * releases, which is newer, when to stay quiet) is a pure function below; the
 * I/O at the bottom only gathers strings for them.
 */

/** Once a day: release cadence is weeks, and this is someone's git server. */
export const UPDATE_TTL_MS = 24 * 60 * 60_000;

export interface UpdateCheck {
  /** when origin was last asked (successfully or not) — the throttle clock */
  checkedAt: string;
  /** installation HEAD when `current`/`dev` were computed; a pull makes them stale */
  commit: string | null;
  /** nearest release tag reachable from HEAD; null = untagged history */
  current: string | null;
  /** highest vX.Y.Z tag on origin; survives a failed check */
  latest: string | null;
  /** why notices are suppressed (a development checkout), if they are */
  dev?: string;
  /** last ls-remote failure; the check never throws into a tick */
  error?: string;
}

type Semver = [number, number, number, string | null];

/** "v1.2.3" or "v1.2.3-rc.1"; anything else is not a version collie knows. */
export function parseVersion(tag: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(tag.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? null] : null;
}

/** <0, 0, >0 like a sort comparator; unparseable versions sort lowest. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] as number) - (pb[i] as number);
    if (d !== 0) return d;
  }
  // same core: a pre-release comes BEFORE its release (semver §11)
  if (pa[3] === pb[3]) return 0;
  if (pa[3] === null) return 1;
  if (pb[3] === null) return -1;
  return pa[3] < pb[3] ? -1 : 1;
}

/**
 * Highest release tag in `git ls-remote --tags --refs` output. Pre-releases and
 * non-version tags are not offered: an rc is something a human opts into by
 * name, never something a notice should nudge everyone onto.
 */
export function latestReleaseTag(lsRemote: string): string | null {
  let best: string | null = null;
  for (const line of lsRemote.split("\n")) {
    const ref = line.split("\t")[1]?.trim();
    if (!ref?.startsWith("refs/tags/")) continue;
    const tag = ref.slice("refs/tags/".length);
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) continue;
    if (!best || compareVersions(tag, best) > 0) best = tag;
  }
  return best;
}

/**
 * A checkout that is being WORKED ON, not run: a feature branch or uncommitted
 * edits. Telling its owner to `collie update` would be telling them to throw
 * their branch away, so notices stay quiet there.
 */
export function devReason(input: {
  branch: string | null;
  defaultBranch: string | null;
  trackedChanges: number;
}): string | undefined {
  if (input.trackedChanges > 0) return "uncommitted changes in the checkout";
  // unknown default branch (origin/HEAD unset) is "don't know", not "dev"
  if (input.defaultBranch && input.branch !== input.defaultBranch) {
    return `on ${input.branch === "HEAD" || !input.branch ? "a detached HEAD" : input.branch}, not ${input.defaultBranch}`;
  }
  return undefined;
}

/** The version worth announcing, or null. An untagged checkout is behind any release. */
export function updateAvailable(check: UpdateCheck | null): string | null {
  if (!check || check.dev || !check.latest) return null;
  if (!check.current) return check.latest;
  return compareVersions(check.latest, check.current) > 0 ? check.latest : null;
}

export interface ChangelogSection {
  version: string;
  text: string;
}

/**
 * Keep-a-Changelog sections (`## [0.2.0] - 2026-10-24`) for versions in
 * (from, to] — what an update just brought in. `from` null = everything up to
 * `to`. "Unreleased" is never part of an update.
 */
export function changelogSections(md: string, from: string | null, to: string): ChangelogSection[] {
  const out: ChangelogSection[] = [];
  const parts = md.split(/^(?=## \[)/m);
  for (const part of parts) {
    const m = /^## \[([^\]]+)\]/.exec(part);
    if (!m) continue;
    const version = m[1]!.trim();
    if (!parseVersion(version)) continue;
    if (from && compareVersions(version, from) <= 0) continue;
    if (compareVersions(version, to) > 0) continue;
    out.push({ version, text: part.trimEnd() });
  }
  return out;
}

// ---------------------------------------------------------------- I/O ----

export function readUpdateCheck(): UpdateCheck | null {
  try {
    const raw = JSON.parse(fs.readFileSync(updateStatePath(), "utf8")) as UpdateCheck;
    return typeof raw.checkedAt === "string" ? raw : null;
  } catch {
    return null;
  }
}

function writeUpdateCheck(check: UpdateCheck): void {
  ensureDataDirs();
  const tmp = `${updateStatePath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(check, null, 2));
  fs.renameSync(tmp, updateStatePath());
}

/** Everything about the checkout itself — no network. */
export function localVersionState(root = installRoot()): Pick<UpdateCheck, "commit" | "current" | "dev"> {
  const head = installGit(["rev-parse", "--abbrev-ref", "HEAD"], root);
  const def = installGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root);
  const status = installGit(["status", "--porcelain", "--untracked-files=no"], root);
  return {
    commit: installCommit(root),
    current: installVersion(root),
    dev: devReason({
      branch: head.ok ? head.out : null,
      defaultBranch: def.ok && def.out ? def.out.replace(/^origin\//, "") : null,
      trackedChanges: status.ok ? status.out.split("\n").filter(Boolean).length : 0,
    }),
  };
}

/** First meaningful stderr line, for a one-line log/doctor entry. */
function firstLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "unknown error";
}

/**
 * Ask origin for its release tags at most once per UPDATE_TTL_MS and cache the
 * answer in update.json, which the TUI and doctor read without touching git's
 * network side.
 *
 * `ls-remote` is deliberately the whole conversation: it reads the remote's
 * refs and writes NOTHING locally — no fetch, no refs, no checkout change. An
 * unattended process may look; only `collie update`, run by a human, moves code.
 *
 * Never throws. A failure is recorded and the clock still advances, so an
 * unreachable origin costs one attempt a day, not one per 30s tick. Between
 * network checks a moved HEAD (someone pulled) refreshes the local half only.
 */
export async function refreshUpdateCheck(
  config: Config,
  opts: { now?: number; force?: boolean } = {},
): Promise<UpdateCheck | null> {
  if (!config.update.check && !opts.force) return null;
  const now = opts.now ?? Date.now();
  const cached = readUpdateCheck();
  const fresh = cached !== null && now - Date.parse(cached.checkedAt) < UPDATE_TTL_MS;
  if (fresh && !opts.force) {
    const commit = installCommit();
    if (commit === cached.commit) return cached;
    const updated = { ...cached, ...localVersionState() };
    if (updated.dev === undefined) delete updated.dev;
    try { writeUpdateCheck(updated); } catch { /* the answer is still good in memory */ }
    return updated;
  }

  const res = await installGitRemote(["ls-remote", "--tags", "--refs", "origin"]);
  const check: UpdateCheck = {
    checkedAt: new Date(now).toISOString(),
    ...localVersionState(),
    latest: res.ok ? latestReleaseTag(res.out) : cached?.latest ?? null,
  };
  if (check.dev === undefined) delete check.dev;
  if (!res.ok) check.error = `git ls-remote origin failed: ${firstLine(res.err)}`;
  try { writeUpdateCheck(check); } catch { /* best-effort cache */ }
  return check;
}
