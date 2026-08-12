import * as fs from "node:fs";
import * as path from "node:path";
import { expandTilde } from "./paths.ts";

/**
 * Discover git repositories under the configured parent directories.
 * Scans up to two levels deep so both flat layouts (~/dev/projects/<repo>)
 * and ghq-style host roots (~/ghq/github.com/<org>/<repo>) work as roots.
 */
/**
 * Why this path cannot be a task's repo, or null when it can.
 *
 * Checked when a task is CREATED, not when it is dispatched. A bad path costs
 * nothing to notice now and costs a whole night to notice later: the task sits
 * queued until 2am, `worktree.create` fails on a directory that was never a
 * checkout, the attempts burn, and the human finds out in the morning. The
 * gitness half is not pedantry — a worktree task cannot be made from a plain
 * directory, which is exactly the mistake a typo'd path produces.
 *
 * `.git` may be a file rather than a directory (a worktree or submodule
 * checkout), and those are perfectly good places to work.
 */
export function repoProblem(repoPath: string): string | null {
  const p = expandTilde(repoPath.trim());
  if (p.length === 0) return "is empty";
  let stat: fs.Stats;
  try {
    stat = fs.statSync(p);
  } catch {
    return "does not exist";
  }
  if (!stat.isDirectory()) return "is not a directory";
  if (!fs.existsSync(path.join(p, ".git"))) return "is not a git repository";
  return null;
}

export function discoverRepos(roots: string[]): string[] {
  const found = new Set<string>();
  for (const rawRoot of roots) {
    const root = expandTilde(rawRoot);
    for (const repo of scan(root, 2)) found.add(repo);
  }
  return [...found].sort();
}

function scan(dir: string, depth: number): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // missing/unreadable root: contribute nothing
  }
  const repos: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const child = path.join(dir, entry.name);
    if (fs.existsSync(path.join(child, ".git"))) {
      repos.push(child);
    } else if (depth > 1) {
      repos.push(...scan(child, depth - 1));
    }
  }
  return repos;
}
