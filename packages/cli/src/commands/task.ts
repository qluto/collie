import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import {
  cancelTask, createTask, getTask, listTasks, retryTask, transition, updateTask,
  expandTilde, repoProblem, stripPromptTemplate, PERMISSION_MODES,
  type Task, type TaskSize, type TaskStatus, type PermissionMode,
} from "@collie/core";

function die(msg: string): never {
  console.error(`collie: ${msg}`);
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
  const tmp = path.join(os.tmpdir(), `collie-prompt-${process.pid}.md`);
  fs.writeFileSync(tmp, initial);
  const res = spawnSync(editor, [tmp], { stdio: "inherit" });
  if (res.status !== 0) die(`$EDITOR (${editor}) exited with ${res.status}`);
  const text = fs.readFileSync(tmp, "utf8");
  fs.unlinkSync(tmp);
  return text;
}

function fmtTask(t: Task): string {
  const wip = t.status === "running" || t.status === "blocked" ? "*" : " ";
  return `${wip} ${t.id}  ${t.status.padEnd(8)} p${String(t.priority).padEnd(4)} ${t.size}${t.model ? ` @${t.model}` : ""} ${path.basename(t.repo).padEnd(20)} ${t.title}`;
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
          model: { type: "string" },
          priority: { type: "string", default: "100" },
          "no-worktree": { type: "boolean", default: false },
          "permission-mode": { type: "string" },
        },
      });
      if (!values.repo) die("--repo is required");
      if (!values.title) die("--title is required");
      // Before $EDITOR, not after: the prompt someone just wrote is not worth
      // losing to a typo'd path (createTask checks again — this is only about
      // when the human finds out).
      const repo = path.resolve(expandTilde(values.repo));
      const repoIssue = repoProblem(repo);
      if (repoIssue) die(`repo ${repo} ${repoIssue}`);
      if (!["S", "M", "L"].includes(values.size!)) die("--size must be S|M|L");
      if (values["permission-mode"] && !PERMISSION_MODES.includes(values["permission-mode"] as PermissionMode)) {
        die(`--permission-mode must be one of ${PERMISSION_MODES.join("|")}`);
      }
      const prompt = stripPromptTemplate(
        values.prompt ?? editorPrompt(`<!-- Write the task prompt for "${values.title}" below. This comment is dropped. -->\n\n`),
      );
      if (prompt.length === 0) die("empty prompt; task not created");
      const task = createTask({
        title: values.title,
        repo,
        prompt,
        size: values.size as TaskSize,
        model: values.model?.trim() || undefined,
        priority: Number(values.priority),
        worktree: values["no-worktree"] ? false : undefined,
        permissionMode: values["permission-mode"] as PermissionMode | undefined,
      });
      console.log(`created ${task.id} (${task.status})`);
      return 0;
    }
    case "list": {
      const { values } = parseArgs({
        args: rest,
        options: { status: { type: "string" }, json: { type: "boolean", default: false } },
      });
      const status = values.status?.split(",") as TaskStatus[] | undefined;
      // done tasks live in the archive; only an explicit --status done digs there
      const tasks = listTasks(status ? { status, includeArchived: status.includes("done") } : undefined);
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
    case "retry": {
      const next = retryTask(requireTask(rest[0]).id, { source: "cli" });
      console.log(`${next.id} -> queued (attempts reset, 0/${next.maxAttempts})`);
      return 0;
    }
    case "done": {
      const t = transition(requireTask(rest[0]).id, "done", undefined, { source: "cli" });
      console.log(`${t.id} -> done`);
      return 0;
    }
    case "cancel": {
      const before = requireTask(rest[0]);
      const t = cancelTask(before.id, { source: "cli" });
      // a queued task is deleted outright, so its "new status" is nothing
      console.log(before.status === "queued" ? `${t.id} deleted` : `${t.id} -> ${t.status}`);
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
      die(`unknown task subcommand "${sub ?? ""}" (see collie --help)`);
  }
}
