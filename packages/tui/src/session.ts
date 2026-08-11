import * as fs from "node:fs";
import { HerdrClient, loadConfig, type Task } from "@collie/core";

interface CreatedWorkspace {
  root_pane?: { pane_id?: string };
  pane?: { id?: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Reopen the conversation a finished task ran, in a workspace of its own.
 *
 * `claude --resume <id>` resolves a session id from ANY directory (live-probed:
 * resuming from an unrelated cwd loads the conversation and appends to the
 * original transcript), so this keeps working after the checkout is gone — the
 * jsonl lives under ~/.claude and outlives both the pane and the worktree. The
 * worktree is still preferred while it exists: the files are then as the agent
 * left them.
 */
export async function openSession(task: Task): Promise<string> {
  const sessionId = task.run?.sessionId;
  if (!sessionId) throw new Error(`${task.id} recorded no session`);
  const wt = task.run?.worktreePath;
  const cwd = wt && fs.existsSync(wt) ? wt : task.repo;
  if (!fs.existsSync(cwd)) throw new Error(`${cwd} is gone`);

  const client = new HerdrClient(loadConfig().herdr.socketPath);
  const ws = await client.request<CreatedWorkspace>("workspace.create", {
    cwd,
    label: `↩ ${task.id}`,
    focus: true,
  });
  const paneId = ws.root_pane?.pane_id ?? ws.pane?.id;
  if (!paneId) throw new Error("workspace.create returned no pane");

  // A pane whose login shell has not reached its prompt swallows typed text
  // (the same race agent.start reports as agent_pane_busy), so wait for the
  // shell to print something rather than guessing a delay. `source` is required
  // and the text hangs off `read`, not the frame.
  for (let i = 0; i < 16; i++) {
    const pane = await client.request<{ read?: { text?: string } }>(
      "pane.read",
      { pane_id: paneId, source: "visible" },
    );
    if ((pane.read?.text ?? "").trim().length > 0) break;
    await sleep(250);
  }
  // Type, then press Enter — the same split the answer flow uses. send_input
  // does NOT submit on its own, and a trailing newline is unreliable: a shell
  // still finishing its rc files swallows it and the command sits at the prompt
  // forever (live-probed, twice).
  await client.request("pane.send_input", { pane_id: paneId, text: `claude --resume ${sessionId}` });
  await client.request("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
  return paneId;
}
