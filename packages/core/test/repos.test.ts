import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverRepos } from "../src/repos.ts";
import { parseConfig } from "../src/config.ts";

function makeTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repos-test-"));
  // flat layout: root/flat/{a,b}, b has no .git
  fs.mkdirSync(path.join(root, "flat", "a", ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "flat", "b"), { recursive: true });
  // ghq-style: root/ghq/org1/{r1,r2}, org2/r3
  fs.mkdirSync(path.join(root, "ghq", "org1", "r1", ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "ghq", "org1", "r2", ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "ghq", "org2", "r3", ".git"), { recursive: true });
  // noise: hidden dir, node_modules
  fs.mkdirSync(path.join(root, "flat", ".hidden", ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "flat", "node_modules", "pkg", ".git"), { recursive: true });
  return root;
}

describe("discoverRepos", () => {
  test("finds depth-1 and depth-2 repos, skips hidden/node_modules", () => {
    const root = makeTree();
    const repos = discoverRepos([path.join(root, "flat"), path.join(root, "ghq")]);
    expect(repos).toEqual([
      path.join(root, "flat", "a"),
      path.join(root, "ghq", "org1", "r1"),
      path.join(root, "ghq", "org1", "r2"),
      path.join(root, "ghq", "org2", "r3"),
    ]);
  });

  test("missing root contributes nothing", () => {
    expect(discoverRepos(["/nonexistent/nowhere"])).toEqual([]);
  });

  test("duplicate roots dedupe", () => {
    const root = makeTree();
    const flat = path.join(root, "flat");
    expect(discoverRepos([flat, flat])).toEqual([path.join(flat, "a")]);
  });
});

describe("config repos.roots", () => {
  test("parses and tilde-expands roots", () => {
    const c = parseConfig(`[repos]\nroots = ["~/dev/projects", "/abs/path"]\n`);
    expect(c.repos.roots[0]).toBe(path.join(os.homedir(), "dev/projects"));
    expect(c.repos.roots[1]).toBe("/abs/path");
  });

  test("defaults to empty; rejects non-arrays", () => {
    expect(parseConfig("").repos.roots).toEqual([]);
    expect(() => parseConfig(`[repos]\nroots = "oops"\n`)).toThrow();
  });
});
