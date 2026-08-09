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
   (schedule window → quota.json blockedUntil → WIP → `modeAdmits` +
   `limitsAllow` in `core/src/quota/gate.ts`) → dispatch: worktree.create → agent.start →
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
- `agent.start` ALWAYS splits off a new pane — there is no "run in this pane"
  argument, and unknown fields are silently ignored (passing `pane_id`/`target`
  spawns anyway). Dispatch therefore closes the root pane of a workspace it
  created, so a task's workspace holds only its agent. Never close the root
  pane from the `worktree.open` path: that workspace may already be a human's.
- Sidebar decoration uses `pane.report_metadata` ONLY (with persisted seq) —
  `pane.report_agent` would feed back into the agent_status we read.

## Quota: real percentages, not token estimates

- The gate reads Anthropic's OWN utilization from `GET /api/oauth/usage` — the
  numbers claude's `/usage` panel shows. Parse `limits[]` (`group` ∈
  session|weekly, `percent`); the sibling top-level keys are internal codenames
  (`tangelo`, `iguana_necktie`, `nimbus_quill`…) that will churn.
- **Undocumented endpoint** — treat it as best-effort: `readLimits()` returning
  null falls the gate back to the ccusage token math, which is why
  `block_budget_tokens` and `size_estimate_tokens` still exist.
- Auth: the LIVE oauth token is in the macOS Keychain (`security
  find-generic-password -s "Claude Code-credentials"`);
  `~/.claude/.credentials.json` goes stale. collie only READS it — never
  refresh, that rotates the user's credentials and can log them out. An expired
  token means "unavailable", not "re-auth".
- Fetched at most every 10min and cached to `$COLLIE_HOME/limits.json` so the
  30s dispatcher tick and the TUI share one call. `refreshLimits()` (async, top
  of the tick) writes it; `readLimits()` (sync) is what the gate reads.
- `fraction_full` / `fraction_conservative` are caps on the session percentage;
  there is deliberately no per-size percentage estimate (it would be another
  uncalibrated guess), so a task can cross the cap mid-run — the limit-hit
  scraper catches that and requeues without burning an attempt.

## Non-obvious invariants

- Three orthogonal task axes, do not conflate them: `size` = token-cost
  estimate (feeds the quota math), `priority` = queue order ONLY (no gating
  power), `defer` = eligibility ("full windows only"). New task fields need a
  `?? default` in `parseTaskFile` — existing files on disk predate them.

- Requeueing MUST clear `run.paneId` (see `requeueOrFail`) — the dispatch
  candidate filter skips tasks with a paneId (half-spawn adoption guard) and a
  stale one starves the task forever. It must ALSO `pane.close` the pane when
  the failure happened after `agent.start`: agent names are server-unique and
  the task id is the name, so a surviving pane makes every retry die with
  `agent_name_taken` (the task then burns all attempts without ever running).
- `retryTask` (human-initiated) resets `attempts` to 0; a plain requeue does
  not. Retrying an exhausted task with no reset gives the dispatcher zero
  retries, so the first hiccup fails it again immediately.
- The dispatcher auto-confirms ONLY the folder-trust dialog. `bypassPermissions`
  adds its own startup confirmation that nothing answers → the task wedges
  until `ready_timeout_sec`. Default permission mode is `auto`.
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
- Below `NARROW_COLUMNS` (70) the board switches to `StackedBoard` — six lanes
  side by side cannot hold a title on a phone. Ink has NO scrolling: anything
  past the last row is gone, so the stacked layout budgets rows explicitly
  (header + cards + the `… +N` row, which is the one that overflows if you
  forget it) and drops whole lanes into a summary line rather than off-screen.
  `Detail` cuts every line to the pane width for the same reason — a wrapped
  line shifts the rest and the repaint lands on the previous frame, which reads
  as corruption.
- Board text is truncated/wrapped by `truncateToWidth`/`wrapToWidth`, never by
  Ink's `wrap="truncate"`: Ink miscounts CJK by a cell and the column border
  falls off the row. Column boxes carry an explicit `width` (not flexGrow) so
  yoga cannot round differently than that arithmetic did; the focused column
  is widened (FOCUS_SHARE, capped at MAX_FOCUS) because six columns of a
  normal terminal leave ~14 cells — too narrow for a Japanese title.
- Jumping to a task's pane uses `agent.focus {target: paneId}` — 0.7.1 has no
  `pane.focus`, and tab/workspace focus need ids a task may not carry.
- `collie done` closes the review loop from wherever the human is: explicit id
  → `COLLIE_TASK_ID` (typed as `!collie done` in the agent's own input box) →
  the task owning `HERDR_ACTIVE_PANE_ID`/`HERDR_PANE_ID`. Bound to a herdr key
  via `[[keys.command]]`, which runs `type = "shell"` commands DETACHED — no
  stdout reaches anyone, so every outcome also goes out as
  `notification.show` (sound ∈ none|done|request). That call is advisory: it
  answers `{shown, reason}` with reason ∈ shown|disabled|rate_limited|
  no_foreground_client|busy — `disabled` when the user has `[ui.toast]
  delivery = "off"`, `busy` while another toast still occupies the slot. Never
  treat a toast as delivered; `collie done` also renames the pane (`✓ <id>`),
  which persists and needs no user setting. `pane.rename` touches `label` only
  — `agent.list`'s `name` (the uniqueness key for agent.start) is separate.
- Herdr plugins (`herdr-plugin.toml`, `plugin.link`) work on 0.7.1, but
  `[[link_handlers]]` do NOT fire on pane link clicks: clicking hands the URL
  to the OS (`link_click` exists in the binary but is unwired in this build),
  and Ghostty only makes http(s) clickable, under cmd+shift. Don't build on it.

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
