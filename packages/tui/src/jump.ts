import { HerdrClient, loadConfig } from "@collie/core";

/**
 * Bring the Herdr tab running this pane to the front. `agent.focus` is the only
 * focus verb that takes a pane (0.7.1 has no pane.focus; tab.focus/workspace.focus
 * want ids we don't always have on the task). Focusing moves the user away from
 * the TUI's own pane — that is the point of the jump.
 */
export async function focusPane(paneId: string): Promise<void> {
  const client = new HerdrClient(loadConfig().herdr.socketPath);
  await client.request("agent.focus", { target: paneId });
}
