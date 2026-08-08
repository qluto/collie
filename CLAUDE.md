# CLAUDE.md

collie is a kanban task queue that dispatches Claude Code sessions into
[Herdr](https://herdr.dev) panes during token-quota idle windows (nights
preferred). Monorepo (bun workspaces): `packages/core` (store, herdr socket
client, quota), `packages/cli` (single `collie` bin: task commands, dispatcher,
hooks), `packages/tui` (Ink kanban).

## Commands

```sh
bun install
bun test                  # full suite; must stay green
bunx tsc --noEmit         # typecheck (strict)
bun packages/cli/src/index.ts <cmd>   # run the CLI from source
collie doctor             # env sanity (herdr socket, claude, ccusage)
```

## ⚠ Live system — isolate your tests

A real launchd dispatcher (`com.qluto.collie.dispatcher`) runs against
`~/.collie` on this machine. **Never point tests at the real data dir**: set
`COLLIE_HOME` to a temp dir in every test/manual experiment (all paths resolve
through `core/src/paths.ts`). Other useful env: `COLLIE_DEBUG=1` (raw socket
frames), `COLLIE_CCUSAGE_BIN` (fixture script instead of real ccusage).

## Architecture (follow the data)

1. Tasks are markdown files in `$COLLIE_HOME/tasks/<id>.md` — YAML frontmatter
   (status machine: backlog/queued/running/blocked/review/done/failed) + body =
   prompt. ALL mutations go through `core/src/store.ts` (global lockfile +
   atomic tmp-rename + rev counter). Never write task files directly.
2. The dispatcher (`cli/src/dispatcher/`) ticks every 30s: reconcile against
   `agent.list` → watchdog (idle timeout, limit scrape) → gates
   (schedule window → quota.json blockedUntil → WIP → ccusage math in
   `core/src/quota/gate.ts`) → dispatch: worktree.create → agent.start →
   verify-inject one-line prompt pointer → Enter → transition to running LAST
   (crash safety; half-spawned panes are adopted via the session-start hook).
3. Spawned claude sessions get generated `--settings` with hooks that call
   back into `collie hook <name>`; task identity rides env `COLLIE_TASK_ID`,
   pane identity `HERDR_PANE_ID`. Completion = the session runs
   `collie task complete <id>` (pre-allowed in generated permissions) →
   review; a human promotes to done in the TUI.

## Herdr 0.7.1 wire facts (live-verified; docs at herdr.dev describe a NEWER build)

- Newline-JSON over `~/.config/herdr/herdr.sock`. Error frames can LOSE the
  request id → never multiplex; `HerdrClient.request` = one connection per
  call, `subscribe` = dedicated connection per pane. Subscribe BEFORE acting.
- `agent.prompt` / `pane.run` do not exist on the wire; enums are snake_case
  (`recent_unwrapped`); `events.wait` is not_implemented.
- `agent.send` does NOT press Enter (`pane.send_keys` with "Enter" does);
  pane text hard-wraps → compare whitespace-stripped when verifying echoes.
- Agent status is screen-scraped and NOT truth: boot spinner reads "working",
  the folder-trust dialog reads "blocked" (dispatcher auto-confirms it),
  `done` = idle+unseen and is erased when a human views the tab. Readiness =
  live `agent.get` returning `idle`, nothing else.
- `agent.start` names are server-unique → the task id is used as agent name.
- `worktree.create` returns a full workspace + root pane; spawn into that
  workspace. Retry path: `worktree.open`, then agents-scan fallback.
- Sidebar decoration uses `pane.report_metadata` ONLY (with persisted seq) —
  `pane.report_agent` would feed back into the agent_status we read.

## Non-obvious invariants

- Requeueing MUST clear `run.paneId` (see `requeueOrFail`) — the dispatch
  candidate filter skips tasks with a paneId (half-spawn adoption guard) and a
  stale one starves the task forever.
- Dispatcher SIGTERM handling: interrupt the inter-tick sleep AND exit
  non-zero (launchd KeepAlive restarts only on unsuccessful exit).
- Hooks must always exit 0 and stay <200ms; failures are swallowed to
  `logs/hooks.log`.
- Limit hits: scrape the pane for "You've hit your … limit · resets …", trust
  Claude's own reset time → `quota.json.blockedUntil` (+jitter); requeue
  WITHOUT burning an attempt.
- Generated artifacts (plists, hook settings, prompt footers) use absolute
  bun + script paths — panes and launchd have no reliable PATH.
- TUI cursor discipline (`tui/src/cursor.ts`): the hardware cursor is parked
  at the focused input for IME preedit anchoring; DECSC before parking, and a
  stdout write-hook DECRC-restores before any non-ours write so Ink's
  relative repaints keep their origin. Ink renders in the alternate screen
  (`runTui`); text input accumulates chunks in a ref (IME commit bursts race
  React batching otherwise). New-task form rows are position-fixed — if you
  change its layout, update REPO_ROW/TITLE_ROW/INPUT_COL in newTask.tsx.

## Testing conventions

- Store tests: fresh `COLLIE_HOME` per test (`freshHome()` pattern); the
  2-process hammer test guards the locking (final rev must equal total writes).
- Herdr client tests run against a fake unix socket (`Bun.listen`).
- Quota gate is a pure function; ccusage is faked via `COLLIE_CCUSAGE_BIN`.
- Live TUI/dispatcher verification: spawn a Herdr pane via the socket API
  (`workspace.create` → `pane.send_text` + Enter), drive with
  `pane.send_keys`, assert on `pane.read` text. Close the workspace after.
- E2E dispatch tests: sandbox git repo + temp COLLIE_HOME; expect the
  folder-trust dialog on first spawn in a new repo.

## Style

- TypeScript strict, `.ts`/`.tsx` extension imports, no default exports.
- Minimal deps (yaml, smol-toml, ink, react — that's the whole tree).
- Comments state constraints the code can't show (wire quirks, race guards),
  not narration.
