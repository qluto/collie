# CLAUDE.md

collie is an unattended-work box for Claude Code sessions on
[Herdr](https://herdr.dev): toss tasks in by day (a task in collie means "this
runs without me"), the dispatcher burns leftover token quota at night
(presence × limits × burn-down), harvest the results in the morning (approve /
answer questions / retry). Monorepo (bun workspaces): `packages/core` (store,
herdr socket client, quota), `packages/cli` (single `collie` bin: task
commands, dispatcher, hooks), `packages/tui` (Ink: harvest view + board).

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
   (status machine: queued/running/blocked/review/done/failed; created tasks
   are always queued, `done` moves the file to `tasks/archive/` under the same
   lock, cancelling a queued task deletes it) + body = prompt. ALL mutations go
   through `core/src/store.ts` (global lockfile + atomic tmp-rename + rev
   counter). Never write task files directly. Legacy files parse leniently:
   `status: backlog` reads as queued, a `defer:` line is dropped on next write.
2. The dispatcher (`cli/src/dispatcher/`) ticks every 30s: reconcile against
   `agent.list` → watchdog (idle timeout, limit scrape, question scrape) →
   gates (schedule window → presence post-process → quota.json blockedUntil →
   WIP (running only) → asking_limit → `modeAdmits` + `limitsAllow` incl.
   burn-down in `core/src/quota/gate.ts`) → dispatch: make the workspace
   (worktree.create, or workspace.create for a non-worktree task) → make the
   pane that carries the task's cwd AND env (`tab.create`, or the root pane
   `workspace.create` already handed back) → agent.start into it → wait for
   `interactive_ready` (auto-confirming the folder-trust dialog) →
   agent.prompt the one-line prompt pointer → transition to running LAST (crash
   safety; half-spawned panes are adopted via the session-start hook).
3. Spawned claude sessions get generated `--settings` with hooks that call
   back into `collie hook <name>`; task identity rides env `COLLIE_TASK_ID`,
   pane identity `HERDR_PANE_ID`. Completion = the session runs
   `collie task complete <id>` (pre-allowed in generated permissions) →
   review; a human promotes to done in the TUI.

## Herdr 0.8.0 wire facts (live-probed 2026-08-11; protocol 19)

**`herdr --skill` prints herdr's own agent-facing manual and `herdr <group>`
(no subcommand) prints that group's exact syntax — read those before guessing.
The CLI and the wire are NOT the same surface: `pane run` exists in the CLI,
`pane.run` does not exist on the wire.**

- Newline-JSON over `~/.config/herdr/herdr.sock`. Error frames could LOSE the
  request id on 0.7.1 → never multiplex; `HerdrClient.request` = one connection
  per call, `subscribe` = dedicated connection per pane. Subscribe BEFORE
  acting. (Not re-tested on 0.8.0; the rule costs nothing.)
- `agent.start` = `{name, kind, pane_id, args?, timeout_ms?}` and **creates no
  layout**: it adopts an EXISTING shell pane. `cwd`/`env`/`argv` are gone from
  the call — cwd and env are properties of the pane you make first
  (`workspace.create`, `tab.create` and `pane.split` all take `cwd` + `env`;
  **`worktree.create` takes neither**), and native claude flags ride in `args`.
  Unknown fields are still silently ignored, so a stale call shape is dropped
  without a word rather than erroring.
- Two things `agent.start` does NOT do, both learned the hard way:
  1. It refuses a pane whose login shell has not reached its prompt yet —
     `agent_pane_busy: not an available shell`. A fat zshrc takes a second, so
     dispatch RETRIES rather than guessing a delay.
  2. It returns as soon as the launch is under way, NOT when the agent is
     usable: for a few seconds there is no named agent at all and
     `agent.prompt` answers `agent_not_ready: not an active named agent`.
- Readiness is `agent.get` reporting `interactive_ready: true` on a record
  whose `name` is ours — never `agent_status`, which is screen-scraped and
  reads `idle` for a pane that merely holds an idle SHELL. (The full record
  also carries `agent` = the kind, `state_change_seq`, cwd/foreground_cwd.)
- `agent.prompt {target, text, wait?, until?, timeout_ms?}` EXISTS now and
  "atomically submits text and encoded Enter while honoring the pane's live
  bracketed-paste mode" — it replaces send → verify-echo → `pane.send_keys
  Enter`. `wait` settles on the first `idle`/`done`/`blocked`; a prompt that
  produces no lifecycle change within 5s answers `agent_prompt_stalled`.
- Blocking waits are implemented (they were `not_implemented` on 0.7.1):
  `agent.wait {target, until?[], timeout_ms?}`, `pane.wait_for_output`
  (`match` is an internally-tagged enum, not a bare string), `events.wait`
  (requires `match_event`). The dispatcher's 2s poll loops predate them.
- `pane.send_input` = atomic text+Enter for a pane that holds no agent (this is
  what the CLI's `pane run` calls). `agent.send` still does NOT press Enter,
  and pane text still hard-wraps → compare whitespace-stripped.
- `pane.focus {pane_id}` exists now; `agent.focus {target}` still works and is
  what the TUI's jump uses.
- Agent status is screen-scraped and NOT truth: boot spinner reads "working",
  the folder-trust dialog reads "blocked" (dispatcher auto-confirms it),
  `unknown` means "present but unclassified", never "finished". `idle` means
  ready AND its tab has been seen; `done` is that same idle state after unseen
  background work. **Reads over the CLI/API do not mark a tab seen — a focus
  command does**, so the TUI's jump is what erases `done`, not its polling.
- Agent names match `[a-z][a-z0-9_-]{0,31}`, must be unique among LIVE agents,
  and are released when the agent exits — collie's task ids satisfy the
  pattern, and a surviving pane is still what makes a retry hit
  `agent_name_taken`.
- Pane ids are workspace-qualified (`w1:p1`) and are NOT reused; a pane moved
  to another workspace gets a NEW id (`pane.move` answers both).
- `worktree.create` returns a full workspace + root pane; spawn into that
  workspace. Retry path: `worktree.open`, then agents-scan fallback. Never
  close the root pane from the `worktree.open` path — that workspace may
  already be a human's.
- Sidebar decoration uses `pane.report_metadata` ONLY (with persisted seq) —
  `pane.report_agent` would feed back into the agent_status we read.
- Popups (new in 0.8.0): `[[keys.command]] type = "popup"` opens a
  session-modal terminal without touching the tab layout, sized in cells or
  percentages, inheriting the calling pane's cwd. One per session
  (`popup already open`), and `popup.close` names no id — which is why only
  `collie new --popup`, the process that knows it IS the popup, calls it.

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
  (`forecast.session_pct_per_task` exists but is display-only: it turns header
  headroom into "≈N tasks", it never gates.)
- **Burn-down** (`[quota.burn_down]`, default on): session headroom is
  use-it-or-lose-it, so within `window_min` of `sessionResetsAt` a full window
  spends up to `burn_down.fraction` (max()-ed — only ever raises). Gate and
  forecast header share `effectiveSessionFraction` so the header can never
  promise headroom the gate refuses. ccusage fallback path has no reset time
  and never burns.
- **Presence** (`[presence]`, default OFF): post-processes the schedule mode,
  never replaces it. Present (input idle < threshold, or a working non-collie
  agent when `respect_other_agents`) caps the mode at `when_present` (default
  `paused`) — a CEILING on every window, not a rewrite of `full` alone: capping
  only full left presence inert through the whole working day, which is when
  there is a human to respect. A non-binding cap still reports itself
  (`presence: human at keyboard (already conservative)`) so "on but inert" is
  distinguishable from "off". Absent + `absent_upgrade` lifts conservative →
  full; paused never upgrades; a failed ioreg probe is "unknown" and changes
  nothing.

## Non-obvious invariants

- Two task axes, do not conflate them: `size` = token-cost estimate (feeds the
  quota math + conservative cap), `priority` = queue order ONLY (no gating
  power). `defer` no longer exists — a task in collie is by definition
  unattended, night-eligible work. New task fields need a `?? default` in
  `parseTaskFile` — existing files on disk predate them.
- Same for config: `loadConfig` writes `DEFAULT_CONFIG_TOML` only when the file
  is MISSING (with `wx`, after `ensureDataDirs` — a fresh machine has no
  `~/.collie` yet), so a config written before a feature never grows its
  section. Every key must survive absence via `pick(..., DEFAULT_CONFIG.x)`,
  and the Config tab shows the EFFECTIVE value, not the file's text — "presence
  off" there with no `[presence]` block on disk is the defaults working.
- WIP counts `running` only — a task blocked on a question burns no tokens, so
  it must not starve the night. `dispatch.asking_limit` (min 1; 0 would pause
  dispatch forever) backstops the pile of unanswered questions instead.
- Question harvest: the Notification hook stores `payload.message` in
  `run.question` (300-char cap); the dispatcher's `scrapeQuestions` writes the
  real pane text to `runs/<id>/question.txt` once per blocked episode
  (`questionScrapedAt` marks it). The stop hook clears both — an answered
  question must not linger. Harvest's `a` answers via `agent.send` + explicit
  `pane.send_keys` Enter and leaves status alone (the stop hook unblocks).

- `done` ≠ merged, and the difference is the point. Merging a task's branch IS
  the review, so the dispatcher's `adoptMerged` promotes a `review` task whose
  branch HEAD already contains straight to `done` (`source: merge-detect`) —
  and what is left in `done` with an unmerged branch is therefore work the human
  looked at and dropped, which harvest shows as `🗑 Dropped` (`x` discards,
  `u` reopens). Three constraints hold that up:
  1. `run.baseCommit` (recorded at dispatch from the fresh checkout's HEAD) is
     what makes "contained in HEAD" mean "landed": a branch that never got a
     commit is contained from birth, and auto-completing it would archive a
     task — an uncommitted plan, say — no human ever read. No baseCommit (older
     tasks) = never auto-adopted.
  2. Nothing is recorded on the task. Dropped-ness is re-derived from git every
     scan (`core/branches.ts`), so merging a dropped task's branch a week later
     un-drops it and discarding the branch ends it, with no field to go stale
     and no second truth to disagree with gc.
  3. The scan runs from the BRANCH side (unmerged `collie/*` whose id is not in
     the working set), never by walking the archive — that directory only
     grows. Its repo roster lives in `branches.json`, seeded from the working
     set and kept while any collie branch survives; only a cold start (no file
     yet) reads a bounded slice of the archive to find repos at all.
  `done→review` is legal so `u` can work, and `transition` deletes the archived
  copy after writing the live one (a crash leaves a duplicate, never nothing).
  `discardTaskWork` is the one destructive path: worktree → prune → `branch -D`,
  refusing outright on tracked changes. That ORDER is not optional — git will
  not delete a branch a checkout still holds.
- `collie gc` reports a task ONLY while something collectable survives: the
  archive grows forever, so "branch already deleted by a human" has to drop out
  of the output (counted as `already clean`) rather than reappear every run.
  Three things make that hold — `localBranches` (one list per repo) answers
  "does the branch still exist" BEFORE any merge question; `commitsAhead`
  returns null, not `[]`, when it could not ask (a vanished branch used to read
  as "0 commits ahead", i.e. as unmerged work); and `worktree prune` runs per
  repo BEFORE branch deletion, because a checkout deleted with `rm` leaves an
  admin entry and `git branch -d` refuses a branch "used by" it — pruning
  afterwards would wedge that branch for good. `dirtyState` splits the two
  risks: tracked changes stop gc dead (`--force` included), untracked files
  only need `--force`, which deletes them outright.
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
  React batching otherwise). Text-input rows are position-fixed — if you
  change a form's layout, update REPO_ROW/TITLE_ROW/INPUT_COL in newTask.tsx
  and ANSWER_INPUT_ROW/QUESTION_LINES in harvest.tsx (the answer overlay pads
  the question block to a fixed height so the input row cannot drift). The
  forecast header (2nd line) renders ONLY when no overlay is open — an extra
  line above a form would shift every fixed row.
- The default tab is Harvest (review / asking / failed with one-key actions);
  the board is the "see everything" sub-view: 5 lanes, `blocked` is labeled
  "Asking", done has no lane (archived out of the working set).
- Done work is still reachable: Harvest ends in a folded `📦 Done N · A to open`
  line that `A` expands into a 4th group (newest 20, `endedAt` desc, Enter opens
  the same Detail). It reads `listArchived(limit)`, NOT the snapshot —
  `snap.tasks` stays the working set the board and dispatcher reason about, and
  the archive only grows, so selection is by file mtime and `limit: 0` (folded)
  is a single readdir per tick. Archived tasks reach `harvestList` only through
  its second argument.
- Below `NARROW_COLUMNS` (70) the board switches to `StackedBoard` — five lanes
  side by side cannot hold a title on a phone. Ink has NO scrolling: anything
  past the last row is gone, so the stacked layout budgets rows explicitly
  (header + cards + the `… +N` row, which is the one that overflows if you
  forget it) and drops whole lanes into a summary line rather than off-screen.
  `Detail` cuts every line to the pane width for the same reason — a wrapped
  line shifts the rest and the repaint lands on the previous frame, which reads
  as corruption.
- Whitespace is budgeted, not decorative: Harvest and Config compute their rows
  with the blank separators included and drop them FIRST when the pane is short
  (Harvest's `airy` flag needs the whole harvest to fit; Config falls back
  spaced → packed → `… +N lines`). Never add a bare blank `<Text>` outside that
  arithmetic — Ink cannot scroll, so it costs a real line of content.
- `displayWidth` carries an explicit East_Asian_Width=W table for the symbol
  blocks (✅ ❌ ❓ are 2 cells, ✓ ✗ · are 1) and reads U+FE0F/U+FE0E, which is
  what decides "⚙" (1) vs "⚙️" (2). Guessing by block is wrong in both
  directions; `padToWidth` builds the Config label column on top of it.
- Board text is truncated/wrapped by `truncateToWidth`/`wrapToWidth`, never by
  Ink's `wrap="truncate"`: Ink miscounts CJK by a cell and the column border
  falls off the row. Column boxes carry an explicit `width` (not flexGrow) so
  yoga cannot round differently than that arithmetic did; the focused column
  is widened (FOCUS_SHARE, capped at MAX_FOCUS) because five columns of a
  normal terminal leave ~15 cells — too narrow for a Japanese title.
- Jumping to a task's pane uses `agent.focus {target: paneId}` (0.8.0 also has
  `pane.focus`; tab/workspace focus need ids a task may not carry). Focusing is
  also what marks a tab seen, i.e. what turns herdr's `done` badge off.
- `collie new [--popup]` is the capture form alone, for a herdr `type = "popup"`
  keybinding (`prefix+t`): the popup inherits the calling pane's cwd, so
  `repoRootOf(cwd)` — the MAIN repo, via `--git-common-dir`, so standing in a
  collie worktree does not propose a worktree of a worktree — heads the repo
  candidates. It says everything twice (stdout for a terminal, `showNotification`
  for a popup that is about to vanish) and only closes the popup with `--popup`.
  Its one layout constraint: the form's inputs park the hardware cursor at
  `REPO_ROW`/`TITLE_ROW` counted from the top of the SCREEN, so the standalone
  view must keep exactly one header line above the form, like the TUI's tab bar
  (`newTask.test.tsx` asserts it).
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
  Because the toast is the ONLY channel, nothing in `runDoneCommand` may throw
  past it: arg parsing and id resolution (`listTasks` touches the filesystem)
  sit INSIDE the try, and `showNotification` falls back to
  `DEFAULT_CONFIG.herdr.socketPath` when `loadConfig` throws — reading the
  socket path out of the very config it needs to complain about is a circular
  dependency whose failure mode is total silence, which reads exactly like the
  keybinding being dead.
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
