import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import {
  cancelTask, createTask, getTask, listTasks, transition, updateTask,
  expandTilde,
  type Task, type TaskSize, type TaskStatus, type PermissionMode,
} from "@agent-hub/core";

function die(msg: string): never {
  console.error(`agent-hub: ${msg}`);
  process.exit(1);
}

function requireTask(id: string | undefined): Task {
  if (!id) die("task id required");
  const t = getTask(id);
  if (!t) die(`no such task: ${id}`);
  return t;
}

function editorPrompt(initial: string): string {
  const editor = process.env.EDITOR ?? "vi";
  const tmp = path.join(os.tmpdir(), `agent-hub-prompt-${process.pid}.md`);
  fs.writeFileSync(tmp, initial);
  const res = spawnSync(editor, [tmp], { stdio: "inherit" });
  if (res.status !== 0) die(`$EDITOR (${editor}) exited with ${res.status}`);
  const text = fs.readFileSync(tmp, "utf8");
  fs.unlinkSync(tmp);
  return text;
}

function fmtTask(t: Task): string {
  const wip = t.status === "running" || t.status === "blocked" ? "*" : " ";
  return `${wip} ${t.id}  ${t.status.padEnd(8)} p${String(t.priority).padEnd(4)} ${t.size}  ${path.basename(t.repo).padEnd(20)} ${t.title}`;
}

export function runTaskCommand(argv: string[]): number {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "add": {
      const { values } = parseArgs({
        args: rest,
        options: {
          repo: { type: "string" },
          title: { type: "string" },
          prompt: { type: "string" },
          size: { type: "string", default: "M" },
          priority: { type: "string", default: "100" },
          "no-worktree": { type: "boolean", default: false },
          "permission-mode": { type: "string" },
          queue: { type: "boolean", default: false },
        },
      });
      if (!values.repo) die("--repo is required");
      if (!values.title) die("--title is required");
      const repo = path.resolve(expandTilde(values.repo));
      if (!fs.existsSync(repo)) die(`repo path does not exist: ${repo}`);
      if (!["S", "M", "L"].includes(values.size!)) die("--size must be S|M|L");
      const prompt = values.prompt ?? editorPrompt(`<!-- Write the task prompt for "${values.title}" below. Lines starting with <!-- are kept. -->\n\n`);
      if (prompt.trim().length === 0) die("empty prompt; task not created");
      const task = createTask({
        title: values.title,
        repo,
        prompt,
        size: values.size as TaskSize,
        priority: Number(values.priority),
        worktree: values["no-worktree"] ? false : undefined,
        permissionMode: values["permission-mode"] as PermissionMode | undefined,
        status: values.queue ? "queued" : "backlog",
      });
      console.log(`created ${task.id} (${task.status})`);
      return 0;
    }
    case "list": {
      const { values } = parseArgs({
        args: rest,
        options: { status: { type: "string" }, json: { type: "boolean", default: false } },
      });
      const filter = values.status
        ? { status: values.status.split(",") as TaskStatus[] }
        : undefined;
      const tasks = listTasks(filter);
      if (values.json) {
        console.log(JSON.stringify(tasks, null, 2));
      } else {
        for (const t of tasks) console.log(fmtTask(t));
        if (tasks.length === 0) console.log("(no tasks)");
      }
      return 0;
    }
    case "show": {
      const t = requireTask(rest[0]);
      console.log(JSON.stringify(t, null, 2));
      return 0;
    }
    case "queue": {
      const t = transition(requireTask(rest[0]).id, "queued", undefined, { source: "cli" });
      console.log(`${t.id} -> queued`);
      return 0;
    }
    case "backlog": {
      const t = transition(requireTask(rest[0]).id, "backlog", undefined, { source: "cli" });
      console.log(`${t.id} -> backlog`);
      return 0;
    }
    case "retry": {
      const t = requireTask(rest[0]);
      const next = transition(t.id, "queued", undefined, { source: "cli" });
      console.log(`${next.id} -> queued (attempt ${next.attempts}/${next.maxAttempts})`);
      return 0;
    }
    case "done": {
      const t = transition(requireTask(rest[0]).id, "done", undefined, { source: "cli" });
      console.log(`${t.id} -> done`);
      return 0;
    }
    case "cancel": {
      const t = cancelTask(requireTask(rest[0]).id, { source: "cli" });
      console.log(`${t.id} -> ${t.status}`);
      return 0;
    }
    case "complete": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { summary: { type: "string" } },
        allowPositionals: true,
      });
      const t = requireTask(positionals[0]);
      if (!values.summary) die("--summary is required");
      const next = transition(t.id, "review", { resultSummary: values.summary }, { source: "session" });
      console.log(`${next.id} -> review`);
      return 0;
    }
    case "fail": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { reason: { type: "string" }, retryable: { type: "boolean", default: false } },
        allowPositionals: true,
      });
      const t = requireTask(positionals[0]);
      if (!values.reason) die("--reason is required");
      const retryable = values.retryable && t.attempts + 1 < t.maxAttempts;
      const next = retryable
        ? transition(t.id, "queued", { failureReason: values.reason }, { source: "session" })
        : transition(t.id, "failed", { failureReason: values.reason }, { source: "session" });
      if (retryable) {
        updateTask(next.id, (task) => {
          task.attempts += 1;
        });
      }
      console.log(`${next.id} -> ${next.status}`);
      return 0;
    }
    default:
      die(`unknown task subcommand "${sub ?? ""}" (see agent-hub --help)`);
  }
}
