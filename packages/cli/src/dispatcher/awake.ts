import { spawn, type ChildProcess } from "node:child_process";

/**
 * Keep the machine from sleeping while the dispatcher lives, via the system's
 * own `caffeinate -imsu` — the night is the whole point, and a lid-closed Mac
 * ticking nothing looks exactly like a dispatcher that is not running.
 *
 * `-w <pid>` ties the assertion to THIS process: caffeinate exits on its own
 * when the dispatcher dies, however it dies (SIGKILL included), so nothing can
 * outlive us and hold the machine awake. Assertions are per-process, so a
 * caffeinate someone else runs neither conflicts with this one nor is
 * touched by it — each releases only what it took.
 *
 * Spawned by absolute path: the dispatcher runs under launchd, whose PATH has
 * no reliable `/usr/bin`.
 */
export function keepAwake(log: (msg: string) => void): (() => void) | null {
  if (process.platform !== "darwin") return null;
  let released = false;
  let child: ChildProcess;
  try {
    child = spawn("/usr/bin/caffeinate", ["-imsu", "-w", String(process.pid)], {
      stdio: "ignore",
    });
  } catch (err) {
    log(`keep_awake: caffeinate unavailable (${(err as Error).message}); the machine may sleep`);
    return null;
  }
  child.on("error", (err) => log(`keep_awake: caffeinate failed (${err.message}); the machine may sleep`));
  child.on("exit", (code, signal) => {
    if (!released) log(`keep_awake: caffeinate exited early (${signal ?? code}); the machine may sleep`);
  });
  log(`keep_awake: caffeinate -imsu -w ${process.pid} (pid ${child.pid})`);
  return () => {
    released = true;
    child.kill("SIGTERM");
  };
}
