import { getTask, updateTask } from "../store.ts";
import type { HerdrClient } from "./client.ts";

/**
 * Push a task's identity into herdr's sidebar row for its pane.
 *
 * Lives in core, not in the dispatcher, because the dispatcher is not the only
 * thing that changes what the row should say: `collie task complete` runs inside
 * the spawned session and is what normally ends a run, so a dispatcher-private
 * helper left the common path reporting "running" forever.
 *
 * Deliberately only pane.report_metadata (display channel), never
 * pane.report_agent: reporting a semantic state would feed back into the
 * agent_status the dispatcher itself reads for scheduling decisions.
 *
 * `tokens` is the whole surface a sidebar layout can reference ($task, $status,
 * $pr); `title` is the row's own label. There is no `custom_status` field on
 * 0.8+ — the call took one for months and herdr silently dropped it, which is
 * why nothing appeared and nothing errored. A null token value CLEARS it, so a
 * task whose PR is not known actively erases a stale $pr rather than leaving a
 * previous task's number on the row.
 *
 * Best-effort throughout: decoration must never fail a dispatch, a tick, or a
 * command's exit code.
 */
export async function reportTaskMetadata(
  client: HerdrClient,
  taskId: string,
  paneId: string,
  status: string,
): Promise<void> {
  try {
    const fresh = getTask(taskId);
    const seq = (fresh?.run?.reportSeq ?? 0) + 1;
    updateTask(taskId, (t) => {
      t.run = { ...t.run, reportSeq: seq };
    });
    const title = fresh?.title ?? taskId;
    const pr = fresh?.run?.prNumber;
    await client.request("pane.report_metadata", {
      pane_id: paneId,
      source: "collie",
      title,
      tokens: { task: title, status, pr: pr ? `#${pr}` : null },
      seq,
    });
  } catch {
    // sidebar decoration is best-effort
  }
}
