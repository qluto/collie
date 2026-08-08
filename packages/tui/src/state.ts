import * as fs from "node:fs";
import { useEffect, useState } from "react";
import {
  dispatcherStatePath, hubHome, listTasks, readQuotaState, tailEvents, tasksDir,
  type DispatcherState, type JournalEvent, type QuotaState, type Task,
} from "@agent-hub/core";

export interface HubSnapshot {
  tasks: Task[];
  dispatcher: DispatcherState | null;
  quota: QuotaState;
  journal: JournalEvent[];
  refreshedAt: number;
}

export function readSnapshot(): HubSnapshot {
  let dispatcher: DispatcherState | null = null;
  try {
    dispatcher = JSON.parse(fs.readFileSync(dispatcherStatePath(), "utf8")) as DispatcherState;
  } catch {
    // not running yet
  }
  return {
    tasks: listTasks(),
    dispatcher,
    quota: readQuotaState(),
    journal: tailEvents(15),
    refreshedAt: Date.now(),
  };
}

/** Live snapshot: fs.watch on the tasks dir + 2s poll fallback (macOS fs.watch is flaky). */
export function useHubSnapshot(): [HubSnapshot, () => void] {
  const [snap, setSnap] = useState<HubSnapshot>(readSnapshot);
  const refresh = () => setSnap(readSnapshot());
  useEffect(() => {
    const interval = setInterval(refresh, 2000);
    let watcher: fs.FSWatcher | undefined;
    try {
      watcher = fs.watch(tasksDir(), refresh);
    } catch {
      // tasks dir may not exist yet; poll covers it
    }
    let hubWatcher: fs.FSWatcher | undefined;
    try {
      hubWatcher = fs.watch(hubHome(), (_e, name) => {
        if (name === "dispatcher.json" || name === "quota.json" || name === "events.jsonl") refresh();
      });
    } catch {
      // ignore
    }
    return () => {
      clearInterval(interval);
      watcher?.close();
      hubWatcher?.close();
    };
  }, []);
  return [snap, refresh];
}
