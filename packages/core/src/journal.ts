import * as fs from "node:fs";
import { journalPath } from "./paths.ts";
import type { JournalEvent } from "./types.ts";

/** Append one event line. O_APPEND writes of one line are atomic enough for a local journal. */
export function appendEvent(event: JournalEvent): void {
  fs.appendFileSync(journalPath(), JSON.stringify(event) + "\n");
}

/** Read the last n events (whole-file read; journal stays small enough locally). */
export function tailEvents(n: number, taskId?: string): JournalEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(journalPath(), "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const events: JournalEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as JournalEvent);
    } catch {
      // skip torn/corrupt line
    }
  }
  const filtered = taskId ? events.filter((e) => e.taskId === taskId) : events;
  return filtered.slice(-n);
}
