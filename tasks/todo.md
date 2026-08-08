# agent-hub build plan

Plan: /Users/qluto/.claude/plans/expressive-bubbling-avalanche.md
Design doc: /Users/qluto/.claude/plans/expressive-bubbling-avalanche-agent-ahub-plan-0de8102b23c5fcfe.md

## Phase 0 — Scaffold + store + task CLI
- [x] Monorepo scaffold (workspaces, tsconfig, gitignore)
- [x] core: types, paths, config, lock, store, journal
- [x] cli: task add/list/show/queue/backlog/retry/cancel/complete/fail, doctor (partial)
- [x] Tests: store unit + illegal transitions + 2-process concurrency (rev=400) — 13 pass
- [x] bun link → `agent-hub` bin

## Phase 1 — MVP end-to-end loop
- [x] herdr client (request one-shot, subscribe long-lived) + fake-socket tests (6 pass)
- [x] dispatcher loop (WIP gate only), dispatch sequence, reconcile, idle watchdog
- [x] hooks: session-start / stop / notification / session-end
- [x] E2E: HELLO.md task queued→running→blocked→review, commit landed; completion
      arrived while dispatcher was dead (hook-only path); kill-pane → SessionEnd
      requeue → unattended re-run to review
- Field findings: folder-trust dialog auto-confirm needed; agent.start name must
  be unique (task id used); pane.read wire format is recent_unwrapped; boot
  spinner briefly reads as "working" (ready check uses live agent.get, idle only)

## Phase 2 — Quota + schedule + limits + launchd
- [x] ccusage wrapper (cache, env override), gate math, schedule windows
- [x] limit-string scraper → blockedUntil (+learned ceiling, attempt-free requeue)
- [x] dispatcher install/uninstall (launchd) — installed, KeepAlive verified
- [x] Unit tests: gate, windows (midnight-crossing), reset parser — 40 total
- Field findings: SIGTERM must interrupt inter-tick sleep + exit non-zero for
  KeepAlive restart; same-ms task creation needed a stable sort tie-breaker

## Phase 3 — Ink TUI
- [x] board / detail / new-task / dashboard / config views
- [x] $EDITOR suspend/resume, fs.watch + poll refresh
- [x] ink-testing-library tests; bun raw-mode verified live in a Herdr pane
      (node fallback not needed)

## Phase 4 — Worktrees + polish
- [x] worktree.create + reuse-on-retry (worktree.open → agents-scan fallback);
      verified E2E: task ran on its own branch, main untouched
- [x] Notification hook blocked flow (+ herdr notification), post-tool-use
      throttled heartbeat
- [x] Sidebar integration via pane.report_metadata ONLY (report_agent would
      feed back into our own status reads)
- [x] README (JA quickstart + EN docs)

## Review

All four phases landed and E2E-verified against live Herdr + real claude
sessions. Real-environment lessons that changed the design:
1. claude's folder-trust dialog reads as blocked/unknown → auto-confirm during
   ready-wait; readiness requires a live `idle` from agent.get (boot spinner
   briefly reads as "working" via cached events).
2. agent.start names are unique per server → task id doubles as the name.
3. Requeue must clear run.paneId or the candidate filter (adoption guard)
   starves the task forever.
4. SIGTERM must interrupt the tick sleep AND exit non-zero, or launchd
   KeepAlive won't restart after an accidental kill.
5. Wire enums are snake_case (recent_unwrapped); pane.run doesn't exist on the
   wire; pane.read wraps hard → whitespace-normalized echo verification.
Deliberate deviation from the design doc: sidebar reporting uses
report_metadata only (see Phase 4 note); completion callback is pre-allowed in
generated settings.json permissions so it never blocks at 3am.

The launchd dispatcher (com.qluto.agent-hub.dispatcher) is installed and
running against the real ~/.agent-hub with the default config (00:00–07:00
full throttle). Queue is empty until real tasks are added.
