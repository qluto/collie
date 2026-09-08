import { describe, expect, test } from "bun:test";
import { claudeArgsFor } from "../src/dispatcher/dispatch.ts";
import type { Task } from "@collie/core";

function task(over: Partial<Task>): Task {
  return {
    id: "t1", title: "t", status: "queued", repo: "/tmp/r", priority: 100, size: "M",
    worktree: true, permissionMode: "auto", claudeArgs: [],
    createdAt: "", updatedAt: "", attempts: 0, maxAttempts: 3, rev: 0, prompt: "",
    ...over,
  };
}

describe("claudeArgsFor", () => {
  test("no model = no flag; claude picks its own default", () => {
    expect(claudeArgsFor(task({}))).not.toContain("--model");
  });

  test("a named model rides as --model, verbatim and before claudeArgs", () => {
    const args = claudeArgsFor(task({ model: "fable", claudeArgs: ["--model", "opus"] }));
    expect(args.slice(-4)).toEqual(["--model", "fable", "--model", "opus"]);
  });
});
