import type { Task } from "@collie/core";

/**
 * The priority writes that move one queued task a single place.
 *
 * `priority` is the only thing that orders the queue (listTasks sorts by it
 * ascending, then by queuedAt), and trading two numbers with a neighbour — what
 * the board's J/K did — is not a swap when they are EQUAL, which is the normal
 * state: every task is created at the same default. Stepping off a shared value
 * by ±1 jumps the card past the entire tied block, so one press sent it to the
 * end of the queue and the cursor, which follows the card it moved, landed on a
 * different task.
 *
 * Positions are assigned instead, densely: the order becomes explicit, the move
 * is exactly one place whatever the numbers were, and only the entries that
 * really change are written. Absolute values are not preserved and nothing
 * needs them to be — priority carries no gating power, only order. New tasks
 * still arrive at the default (100) and therefore at the back, which is where a
 * freshly tossed-in task belongs.
 *
 * @returns the writes to apply, or null when the card is already at that end.
 */
export function reorderPlan(
  queued: Task[],
  id: string,
  earlier: boolean,
): Array<{ id: string; priority: number }> | null {
  const from = queued.findIndex((t) => t.id === id);
  const to = from + (earlier ? -1 : 1);
  if (from < 0 || to < 0 || to >= queued.length) return null;
  const order = [...queued];
  order.splice(to, 0, ...order.splice(from, 1));
  return order
    .map((t, priority) => ({ id: t.id, priority }))
    .filter((w, i) => order[i]!.priority !== w.priority);
}
