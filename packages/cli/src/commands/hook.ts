import * as fs from "node:fs";
import * as path from "node:path";
import { getTask, logsDir, transition, updateTask } from "@agent-hub/core";

/**
 * Claude Code hook entrypoints. Contract: NEVER block or fail the session —
 * always exit 0, keep total work well under 200ms, swallow and log errors.
 * Task identity comes from AGENT_HUB_TASK_ID (set by the dispatcher's
 * agent.start env); pane identity from HERDR_PANE_ID (set by Herdr).
 */

function hlog(msg: string): void {
  try {
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.appendFileSync(path.join(logsDir(), "hooks.log"), `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // logging is best-effort
  }
}

async function readStdinJson(timeoutMs = 500): Promise<Record<string, unknown>> {
  try {
    const text = await Promise.race([
      new Response(process.stdin as unknown as ReadableStream).text(),
      new Promise<string>((r) => setTimeout(() => r(""), timeoutMs)),
    ]);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function runHookCommand(argv: string[]): Promise<number> {
  const [name] = argv;
  const taskId = process.env.AGENT_HUB_TASK_ID;
  if (!taskId || !name) return 0; // not one of our sessions — stay silent
  try {
    const payload = await readStdinJson();
    const task = getTask(taskId);
    if (!task) {
      hlog(`${name}: unknown task ${taskId}`);
      return 0;
    }
    const now = new Date().toISOString();
    switch (name) {
      case "session-start": {
        const paneId = process.env.HERDR_PANE_ID;
        updateTask(taskId, (t) => {
          t.run = {
            ...t.run,
            sessionId: (payload.session_id as string) ?? t.run?.sessionId,
            paneId: paneId ?? t.run?.paneId,
            lastHeartbeatAt: now,
          };
        });
        hlog(`session-start: ${taskId} pane=${paneId} session=${payload.session_id}`);
        break;
      }
      case "stop": {
        updateTask(taskId, (t) => {
          t.run = { ...t.run, lastHeartbeatAt: now, idleSince: now };
        });
        // A stop while blocked means the human answered the prompt in the pane.
        if (task.status === "blocked") {
          transition(taskId, "running", undefined, { source: "hook-stop" });
        }
        break;
      }
      case "notification": {
        if (task.status === "running") {
          transition(taskId, "blocked", undefined, { source: "hook-notification" });
          hlog(`notification: ${taskId} -> blocked`);
        }
        break;
      }
      case "session-end": {
        if (task.status === "running" || task.status === "blocked") {
          const attempts = task.attempts + 1;
          updateTask(taskId, (t) => {
            t.attempts = attempts;
          });
          const to = attempts < task.maxAttempts ? "queued" : "failed";
          transition(
            taskId,
            to,
            // clear pane identity so a requeued task is dispatchable again
            { failureReason: "session_ended", paneId: undefined, tabId: undefined, sessionId: undefined },
            { source: "hook-session-end" },
          );
          hlog(`session-end: ${taskId} -> ${to}`);
        }
        break;
      }
      default:
        hlog(`unknown hook: ${name}`);
    }
  } catch (err) {
    hlog(`${name}: error ${(err as Error).message}`);
  }
  return 0;
}
