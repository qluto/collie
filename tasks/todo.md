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
- [ ] herdr client (request one-shot, subscribe long-lived) + fake-socket tests
- [ ] dispatcher loop (WIP gate only), dispatch sequence, reconcile, idle watchdog
- [ ] hooks: session-start / stop / session-end
- [ ] E2E: sandbox repo HELLO.md task → review; kill-dispatcher / kill-pane recovery

## Phase 2 — Quota + schedule + limits + launchd
- [ ] ccusage wrapper (cache, env override), gate math, schedule windows
- [ ] limit-string scraper → blockedUntil
- [ ] dispatcher install/uninstall (launchd)
- [ ] Unit tests: gate, windows (midnight-crossing), reset parser

## Phase 3 — Ink TUI
- [ ] board / detail / new-task / dashboard / config views
- [ ] $EDITOR suspend/resume, fs.watch + poll refresh
- [ ] ink-testing-library tests; bun raw-mode check

## Phase 4 — Worktrees + polish
- [ ] worktree.create + reuse-on-retry
- [ ] Notification hook blocked flow, post-tool-use heartbeat
- [ ] pane.report_agent / report_metadata sidebar integration, notifications
- [ ] README (JA quickstart + EN docs)

## Review
(fill after each phase)
