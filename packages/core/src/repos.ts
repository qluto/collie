import * as fs from "node:fs";
import * as path from "node:path";
import { expandTilde } from "./paths.ts";

/**
 * Discover git repositories under the configured parent directories.
 * Scans up to two levels deep so both flat layouts (~/dev/projects/<repo>)
 * and ghq-style host roots (~/ghq/github.com/<org>/<repo>) work as roots.
 */
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
