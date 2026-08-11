import { DEFAULT_CONFIG, loadConfig } from "../config.ts";
import { HerdrClient } from "./client.ts";

export type NotificationSound = "none" | "done" | "request";

/**
 * Never let a bad config silence the toast. An invalid ~/.collie/config.toml
 * makes loadConfig throw, and the toast is exactly how a detached command
 * (a herdr `type = "shell"` keybinding) would report that — reading the socket
 * path through the config it is trying to complain about is a circular
 * dependency that ends in total silence. The default path is right on every
 * machine that has not moved the socket.
 */
function socketPath(): string {
  try {
    return loadConfig().herdr.socketPath;
  } catch {
    return DEFAULT_CONFIG.herdr.socketPath;
  }
}

/**
 * Best-effort toast. Commands bound to a herdr key run without a terminal of
 * their own (`type = "shell"` is detached, a `type = "popup"` window is gone
 * the moment it closes), so this is often the only feedback a human gets — but
 * herdr answers {shown:false, reason:"disabled"} when toasts are off
 * ([ui.toast] delivery), so a caller must never assume it landed.
 */
export async function showNotification(
  body: string,
  sound: NotificationSound = "none",
  title = "collie",
): Promise<boolean> {
  try {
    const client = new HerdrClient(socketPath());
    const res = await client.request<{ shown?: boolean }>("notification.show", {
      title, body, sound,
    });
    return res.shown === true;
  } catch {
    return false; // herdr may not be running; the command still did its job
  }
}

/**
 * Close the session-modal popup a `type = "popup"` keybinding opened (herdr
 * 0.8.0+). A session holds at most one popup and the wire call names no id, so
 * only a command that KNOWS it is the popup's own process may call this —
 * hence the explicit `collie new --popup` flag rather than a guess. Answers
 * false when no popup is open (popup_not_open) or herdr is unreachable.
 */
export async function closePopup(): Promise<boolean> {
  try {
    const client = new HerdrClient(socketPath());
    await client.request("popup.close", {});
    return true;
  } catch {
    return false;
  }
}
