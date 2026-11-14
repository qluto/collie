import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { defaultBranch } from "./git.ts";

export type PullRequestState = "OPEN" | "CLOSED" | "MERGED";

export interface PullRequestRef {
  number: number;
  url: string;
  /** absent when gh answered without it — read as "not known merged" */
  state?: PullRequestState;
  /** the branch the PR targets, e.g. "main" */
  baseRefName?: string;
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
      ["pr", "list", "--head", branch, "--state", "all", "--json", "number,url,state,baseRefName", "--limit", "1"],
      { cwd: repoRoot, encoding: "utf8", timeout: 15_000 },
    );
    if (res.status !== 0 || !res.stdout) return null;
    const parsed = JSON.parse(res.stdout) as unknown;
    if (!Array.isArray(parsed)) return null;
    const first = parsed[0] as
      | { number?: unknown; url?: unknown; state?: unknown; baseRefName?: unknown }
      | undefined;
    if (!first || typeof first.number !== "number" || typeof first.url !== "string") return null;
    const state = first.state === "OPEN" || first.state === "CLOSED" || first.state === "MERGED"
      ? first.state
      : undefined;
    return {
      number: first.number,
      url: first.url,
      ...(state ? { state } : {}),
      ...(typeof first.baseRefName === "string" ? { baseRefName: first.baseRefName } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The repository's default branch as GitHub names it — only asked when
 * `origin/HEAD` is unset locally, which plenty of clones never set. null on
 * any failure, same contract as findPullRequest.
 */
export function ghDefaultBranch(repoRoot: string): string | null {
  try {
    const res = spawnSync(
      ghBin(),
      ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      { cwd: repoRoot, encoding: "utf8", timeout: 15_000 },
    );
    const name = res.status === 0 ? (res.stdout ?? "").trim() : "";
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * Did this PR land on the default branch? The git-side scan (core/branches.ts)
 * cannot see a squash or rebase merge — the branch tip is never contained in
 * main — nor a merge on GitHub that no local fetch has brought in yet, so the
 * PR's own state is the second witness. A PR merged into some other branch
 * (a stacked PR's parent, a release branch) has not landed and does not count.
 * Default branch unknown = "don't know" = not landed.
 */
export function pullRequestLanded(repoRoot: string, pr: PullRequestRef): boolean {
  if (pr.state !== "MERGED" || !pr.baseRefName) return false;
  const base = defaultBranch(repoRoot) ?? ghDefaultBranch(repoRoot);
  return base !== null && base === pr.baseRefName;
}
