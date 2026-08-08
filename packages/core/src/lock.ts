import * as fs from "node:fs";
import { lockPath } from "./paths.ts";

const STALE_MS = 15_000;
const RETRY_MS = 25;
const TIMEOUT_MS = 5_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquire the global advisory lock, run fn, release. Lock is a file created
 * with O_EXCL containing {pid, ts}; a holder older than STALE_MS is stolen.
 */
export function withLock<T>(fn: () => T): T {
  const p = lockPath();
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(p, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      fs.closeSync(fd);
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const holder = JSON.parse(fs.readFileSync(p, "utf8")) as { ts?: number };
        if (typeof holder.ts === "number" && Date.now() - holder.ts > STALE_MS) {
          fs.unlinkSync(p); // stale — steal and retry immediately
          continue;
        }
      } catch {
        // unreadable/torn lock file: treat as contended, retry below
      }
      if (Date.now() > deadline) {
        throw new Error(`collie: could not acquire lock ${p} within ${TIMEOUT_MS}ms`);
      }
      sleepSync(RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(p);
    } catch {
      // already stolen/removed; nothing to do
    }
  }
}
