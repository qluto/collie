import { HerdrClient, loadConfig } from "@collie/core";

/**
 * Type a human's answer into a blocked agent's input box, from the TUI.
 *
 * Two calls, not one: `agent.send` only fills the box on 0.7.1 — pressing
 * Enter is `pane.send_keys`. The task's status is left alone; the session's
 * own stop hook moves it back out of blocked once it resumes.
 */
export async function answerPane(paneId: string, text: string): Promise<void> {
  const client = new HerdrClient(loadConfig().herdr.socketPath);
  await client.request("agent.send", { target: paneId, text });
  await client.request("pane.send_keys", { pane_id: paneId, keys: ["Enter"] });
}
