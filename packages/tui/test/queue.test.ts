import { describe, expect, test } from "bun:test";
import { reorderPlan } from "../src/queue.ts";
import type { Task } from "@collie/core";

/** Only the two fields the queue order is made of. */
const q = (id: string, priority: number): Task => ({ id, priority } as Task);

/** What listTasks would hand back next: priority ascending, id as the tie-break. */
function applied(queued: Task[], plan: Array<{ id: string; priority: number }> | null): string[] {
  const by = new Map(plan?.map((w) => [w.id, w.priority]));
  return [...queued]
    .map((t) => ({ id: t.id, priority: by.get(t.id) ?? t.priority }))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .map((t) => t.id);
}

describe("reorderPlan", () => {
  // The bug the board shipped with: every task is created at the same default
  // priority, and there "swap with the neighbour's number" moved the card past
  // the whole tied block — one press sent it to the end of the queue.
  test("an all-equal queue still moves the card exactly one place", () => {
    const queued = [q("a", 100), q("b", 100), q("c", 100)];
    expect(applied(queued, reorderPlan(queued, "a", false))).toEqual(["b", "a", "c"]);
    expect(applied(queued, reorderPlan(queued, "c", true))).toEqual(["a", "c", "b"]);
  });

  test("moves one place at a time, and back", () => {
    const queued = [q("a", 0), q("b", 1), q("c", 2), q("d", 3)];
    const later = reorderPlan(queued, "b", false);
    expect(applied(queued, later)).toEqual(["a", "c", "b", "d"]);
    const moved = [q("a", 0), q("c", 1), q("b", 2), q("d", 3)];
    expect(applied(moved, reorderPlan(moved, "b", true))).toEqual(["a", "b", "c", "d"]);
  });

  test("the ends are a no-op, not a wrap", () => {
    const queued = [q("a", 0), q("b", 1)];
    expect(reorderPlan(queued, "a", true)).toBeNull();
    expect(reorderPlan(queued, "b", false)).toBeNull();
    expect(reorderPlan(queued, "ghost", false)).toBeNull();
    expect(reorderPlan([], "a", true)).toBeNull();
  });

  // Every write is a task file under the global lock, so a move that changes
  // two positions must not rewrite the whole queue.
  test("writes only the entries whose number actually changes", () => {
    const queued = [q("a", 0), q("b", 1), q("c", 2), q("d", 3)];
    expect(reorderPlan(queued, "c", false)).toEqual([
      { id: "d", priority: 2 },
      { id: "c", priority: 3 },
    ]);
  });
});
