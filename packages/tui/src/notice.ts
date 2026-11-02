import { updateAvailable, type UpdateCheck } from "@collie/core";

export interface CodeNotice {
  text: string;
  color: string;
}

/**
 * The one header segment about collie's own code, or null. Drift first: code
 * that already changed on disk but is not what is running is a present
 * problem; a newer release is only an offer.
 *
 * - the dispatcher (alive, and it reported its boot commit) runs an older
 *   commit than the checkout — the launchd job fixes that itself within two
 *   ticks, so this mostly shows for a manual run
 * - this TUI loaded an older commit than the checkout — only a restart fixes it
 * - a newer release exists, and the check was made against THIS HEAD (a pull
 *   since then makes `current` stale, so the notice waits for the next check)
 */
export function codeNotice(input: {
  diskCommit: string | null;
  tuiCommit: string | null;
  dispatcherCommit: string | undefined;
  dispatcherAlive: boolean;
  update: UpdateCheck | null;
  updateCheckEnabled: boolean;
}): CodeNotice | null {
  const { diskCommit: disk } = input;
  if (disk && input.dispatcherAlive && input.dispatcherCommit && input.dispatcherCommit !== disk) {
    return { text: "↻ dispatcher on old code", color: "yellow" };
  }
  if (disk && input.tuiCommit && input.tuiCommit !== disk) {
    return { text: "↻ old code — restart tui", color: "yellow" };
  }
  if (input.updateCheckEnabled && input.update && input.update.commit === disk) {
    const latest = updateAvailable(input.update);
    if (latest) return { text: `↑ ${latest} · collie update`, color: "cyan" };
  }
  return null;
}
