import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

export interface PullRequestRef {
  number: number;
  url: string;
}

/**
 * Candidate locations for `gh`, in order. The dispatcher runs under launchd,
 * whose PATH has neither /opt/homebrew/bin nor /usr/local/bin — the same trap
 * that made every presence probe read "unknown" until ioreg was spawned
 * absolutely. A bare "gh" is the last resort, for a PATH that does have it.
 */
const GH_CANDIDATES = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"];

export function ghBin(): string {
  const override = process.env.COLLIE_GH_BIN;
  if (override) return override;
  return GH_CANDIDATES.find((p) => fs.existsSync(p)) ?? "gh";
}

/**
 * The pull request for `branch`, if GitHub has one — any state, so a merged PR
 * still shows on a task in review.
 *
 * Best-effort by construction and never throws: no gh installed, no GitHub
 * remote, not authenticated, a network stall, unparseable JSON all answer null.
 * A task's sidebar token and detail link are decoration; nothing may fail a
 * dispatch or a tick because a third-party CLI was unhappy.
 */
export function findPullRequest(repoRoot: string, branch: string): PullRequestRef | null {
  if (!branch) return null;
  try {
    const res = spawnSync(
      ghBin(),
      ["pr", "list", "--head", branch, "--state", "all", "--json", "number,url", "--limit", "1"],
      { cwd: repoRoot, encoding: "utf8", timeout: 15_000 },
    );
    if (res.status !== 0 || !res.stdout) return null;
    const parsed = JSON.parse(res.stdout) as unknown;
    if (!Array.isArray(parsed)) return null;
    const first = parsed[0] as { number?: unknown; url?: unknown } | undefined;
    if (!first || typeof first.number !== "number" || typeof first.url !== "string") return null;
    return { number: first.number, url: first.url };
  } catch {
    return null;
  }
}
