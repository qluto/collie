# collie 🐑🐑🐕

An unattended-work box for Claude Code sessions, orchestrated through
[Herdr](https://herdr.dev) — the herder's sheepdog.

Toss coding tasks in by day. A dispatcher spends your leftover token quota on
them at night, while you are not at the keyboard. Collect the results in the
morning: approve what landed, answer the questions your agents got stuck on,
retry the failures.

*[日本語版 README](README_ja.md)*

---

## What it does

Putting a task into collie is a declaration: **this runs without me.** That one
idea shapes everything below.

### The daily loop

| | |
|---|---|
| **Day** | Toss a task in — three questions (repo, title, size), then `$EDITOR` for the prompt. Ten seconds. |
| **Night** | The dispatcher picks tasks off the queue when the schedule, your absence and the remaining quota all agree. |
| **Morning** | Collect: approve, answer, retry. |

A task has exactly two axes, and they never mean the same thing:

- **`size`** (S/M/L) — an estimate of token cost. It gates: a conservative
  window will not pick up an oversized task.
- **`priority`** — queue order, nothing else. It has no gating power at all.

### Quota from the source, not from a guess

The gate reads Anthropic's own consumption percentages — the numbers Claude
Code shows in its `/usage` panel — from `GET /api/oauth/usage`, at most once
every 10 minutes, cached to `$COLLIE_HOME/limits.json` so the dispatcher and
the TUI share one call. `fraction_full` and `fraction_conservative` are caps on
*those* percentages.

It is an undocumented endpoint, so it is treated as best-effort: when it cannot
be read, the gate falls back to ccusage's token estimates
(`block_budget_tokens` and friends). Authentication is the Claude OAuth token
in the macOS Keychain, which collie only ever **reads** — an expired token
means "unavailable", never "re-authenticate", because refreshing would rotate
your credentials.

**Burn-down.** Session budget evaporates at the reset, so `[quota.burn_down]`
(on by default) relaxes the cap to `fraction` (0.95) once a full window is
within `window_min` of the reset. Unspent headroom was going to be lost anyway.
The header shows `⌛ burn-down` while it applies.

### Presence — not while you are here

Off by default. With `[presence] enabled = true`, macOS input-idle time becomes
a gate signal: while a human is at the machine the mode is capped at
`when_present` (default `paused`).

That cap applies to **every** window, not just full ones. When it capped only
`full`, presence did nothing all day in a conservative window — which is
exactly when there is a human to respect — and tasks were dispatched over the
user's shoulder. `absent_upgrade = true` lets a long-idle machine run full
outside its windows; `paused` never upgrades. A cap that does not bind still
reports itself (`presence: human at keyboard (already conservative)`), so "on
but doing nothing" is distinguishable from "off".

### Isolation and review

Each task runs in its own git worktree on its own `collie/<id>` branch, in its
own Herdr pane. Nothing reaches `done` until a human has looked: a finished
session lands in **review**, and you promote it.

**Merging a branch IS the review.** A reviewed task whose branch is already
contained in HEAD is promoted to done automatically. What remains in done with
an *unmerged* branch is therefore work you looked at and dropped — the TUI
shows it as `🗑 Dropped`, where you can discard the branch or reopen the task.
Nothing is recorded on the task for this; it is re-derived from git on every
scan, so merging a dropped task's branch a week later simply un-drops it.

**A task's repo is checked when it is created**, not when it is dispatched: it
must exist, be a directory, and be a git checkout. The capture form will not
leave the repo field, and `task add` stops before opening `$EDITOR`. The
alternative is finding out at 2am, when `worktree.create` fails, the attempts
burn, and you learn about it the next morning.

### Questions don't kill the night

A task blocked on a question stops counting toward the WIP limit — it burns no
tokens — so one stuck session cannot starve the queue. The hook's message plus
a scrape of the pane land on the task, ready for the morning, and
`asking_limit` keeps the pile from growing without bound.

### Linear import (optional, off by default)

Issues carrying a marker label become queued tasks. It is someone else's API,
so it is polled in minutes (`poll_interval_min`, default 5), never on the 30s
dispatch tick.

**Which repo an issue is about is a chain, not a mapping** — one Linear
workspace is not one repo, and often one *team* is not either:

1. a repo label on the issue — a child of the Linear label **group** `repo`
   (the API reports it as `name="myapp", parent="repo"`; the group name is
   nowhere in the child's own name), or a flat `repo:myapp` label
2. the issue's **project name** — the usual axis inside one team
3. the **team key** — "everything else goes here"

At each rung the name is looked up in `[linear.repos]` and then matched by
directory name against the checkouts under `[repos] roots`. A Linear project
named like its checkout therefore needs **no configuration at all**; the table
is only for when the two names disagree. Every import reports which rung
answered (`via project myapp`).

Two deliberate asymmetries: a repo label that resolves to nothing **stops the
chain** (it names a repo, and ignoring it would ship the work elsewhere while
looking like it worked), while an unmapped project falls through to the team
(a project is only how the board is organised).

**An issue that is passed over always says why.** An issue labelled for collie
that quietly never becomes a task is the failure worth an evening, so
`collie linear sync --dry-run` prints the whole plan and writes nothing:

```
would import  ENG-42  fix the flaky login test  -> ~/dev/projects/myapp  (via project myapp)
skip    ENG-43  state "In Progress" is already under way
skip    OPS-7   no repo named OPS (repo/… label, project, team) — add it to [linear.repos] or rename to match a checkout
1 would be imported, 2 skipped (dry run: nothing written)
```

**Linear's status moves when the work starts, not when it was collected.**
Importing only means the issue reached the queue, where it may sit all evening
behind presence, WIP or the quota gate; "In Progress" then would be the board
telling a lie. The dispatcher moves it right after the task transitions to
running — re-reading the issue first, since the import snapshot is hours old by
then — and comments with the task id and branch name. All of it is
best-effort: a failure is a warning on a session that keeps running.

Double collection is prevented twice over: a local ledger (`linear.json`) and
Linear's own board (a task that has run left its issue in a started state, and
started issues are not import candidates). Linear's priority becomes queue
order (Urgent first; unset counts as Normal).

### Permission modes

The default is `auto`, which is Claude Code's own default: a classifier runs
the tool calls it judges low-risk and blocks the rest — the right fit for
unattended work. `bypassPermissions` shows a startup confirmation dialog that
**the dispatcher does not auto-confirm** (unlike the folder-trust dialog, that
one is a deliberate gate), so a task using it will wedge in front of the
dialog.

### How it works

```
task .md files ──> dispatcher (launchd, 30s tick)
                      │  gates: schedule window → presence → blockedUntil
                      │         → WIP (running only) → asking_limit
                      │         → quota % incl. burn-down (ccusage fallback)
                      ▼
                Herdr socket API: worktree.create → agent.start (claude
                --settings hooks) → inject one-line prompt pointer → Enter
                      │
                claude session ──hooks──> task file heartbeats / blocked / requeue
                      └── final action: `collie task complete <id> --summary …`
                          → review (a human promotes it to done)
```

Key design decisions, learned the hard way:

- **Completion is an explicit CLI callback** — not Herdr's `done` status (which
  clears when a human views the tab) and not the Stop hook (which fires after
  every response). A watchdog routes forgotten callbacks to review after
  `idle_grace_min`, so nothing hangs silently.
- **Prompt injection is a one-line pointer** to `runs/<id>/prompt.md`;
  multiline pastes into the Claude input box are a trap.
- **Startup dialogs**: the folder-trust dialog reads as `blocked`/`unknown`,
  and the dispatcher auto-confirms it — queueing a task for a repo *is* the
  trust decision. Readiness is a live `interactive_ready` from `agent.get`,
  never the screen-scraped status.
- **No socket multiplexing**: Herdr error frames can lose the request id, so
  the client makes one request per connection, plus one dedicated subscribe
  connection per running pane.
- **Sidebar reporting uses `pane.report_metadata` only** — reporting semantic
  agent state would feed back into the `agent_status` the dispatcher reads.
- **Limit hits** are scraped from the pane (`You've hit your session limit ·
  resets 3:45pm`); Claude's own printed reset time becomes a hard dispatch stop
  (plus jitter) and the task requeues **without** burning an attempt.

---

## Setup

### Requirements

- macOS (presence uses the IOKit HID idle timer; the dispatcher is a launchd
  agent)
- [Herdr](https://herdr.dev) running, with its socket at
  `~/.config/herdr/herdr.sock`
- [Bun](https://bun.sh)
- Claude Code on `PATH`

### 1. Install

```sh
bun install

# put a `collie` shim on PATH (or use `bun link`)
printf '#!/bin/sh\nexec %s %s "$@"\n' "$(which bun)" "$PWD/packages/cli/src/index.ts" \
  > ~/.local/bin/collie && chmod +x ~/.local/bin/collie
```

### 2. Check the environment

```sh
collie doctor
```

It verifies the data directory, the config file, the Herdr socket, the presence
probe, Claude Code, ccusage, and the usage API.

### 3. Configure

`~/.collie/config.toml` is written with commented defaults on first run. The
settings worth visiting first:

```toml
[[schedule.windows]]
start = "00:00"
end = "07:00"
mode = "full"        # outside every window: conservative

[repos]
# scanned two levels deep, so both flat layouts and ghq host roots work
roots = ["~/dev/projects", "~/ghq/github.com"]

[presence]
enabled = true       # nothing new starts while you are at the keyboard
```

`[repos] roots` feeds the new-task repo picker (type to filter, ↑↓ to select,
free input still allowed) and the Linear importer's name matching.

Mode names are the config file's vocabulary; the TUI header says what each mode
will actually **pick up** — `● any size` / `● up to M` / `● paused`. The Config
tab is the one place both appear side by side (`00:00-07:00 full — any size`).

### 4. Run the dispatcher

```sh
collie dispatcher install     # launchd agent, starts immediately
collie dispatcher status
tail -f ~/.collie/logs/dispatcher.log
```

`collie dispatcher restart` picks up new code. Config edits need no restart —
they are reloaded on the next tick.

### 5. Optional: Linear

The API key is read from the macOS Keychain, never from `config.toml` (the
Config tab renders that file in full):

```sh
security add-generic-password -s "collie-linear" -a "$USER" -w "lin_api_..."
```

```toml
[linear]
enabled = true
label = "collie"             # collect open issues carrying this label
poll_interval_min = 5
size = "M"                   # size every imported task gets
start_state = ""             # "" = the team's first started state
comment = true               # comment the collie task id back onto the issue
repo_label_group = "repo"    # Linear label group whose child names the repo
repo_label_prefix = "repo:"  # flat spelling, for workspaces without groups

[linear.repos]
# only needed where a Linear name and a checkout's directory name disagree
"Mobile app" = "~/dev/projects/myapp"
"ENG"        = "~/dev/projects/monorepo"   # the "everything else" default
```

Then check it without writing anything:

```sh
collie linear status
collie linear sync --dry-run
```

Leaving the section out entirely is a complete configuration: collie makes no
network calls to Linear and does not even read the Keychain.

### 6. Optional: Herdr keybindings

A capture popup and a one-key "done", so neither costs a trip back to the TUI:

```toml
# ~/.config/herdr/config.toml
[[keys.command]]
key = "prefix+t"
type = "popup"                          # inherits the calling pane's cwd
command = "~/.local/bin/collie new --popup"

[[keys.command]]
key = "prefix+d"
type = "shell"
command = "~/.local/bin/collie done"    # absolute path required
```

`type = "shell"` runs detached, so no stdout reaches anyone: results come back
as a Herdr notification (nothing appears if `[ui.toast] delivery = "off"`) and,
as a channel that needs no setting, the pane is renamed `✓ <task id>`.

---

## Using it

### The TUI

```sh
collie tui
```

Full-screen (alternate screen, like vim or htop), restoring your shell on exit.
IME-aware: preedit text appears inline at the input cursor, and multi-character
commits do not drop characters.

There are two tabs, **Tasks** and **Config**. Tasks is one vertical list of
every task, in the order a human deals with it — the three groups that want a
decision, then the two that want nothing, then what is settled:

```
✅ Review  2                                    ← diff summary per card
❓ Asking  1                                    ← the agent's question, inline
❌ Failed  1
🏃 Running  1 · J jump · x cancel               ← with a heartbeat
⏳ Queued  3 · e edit · [ ] reorder · x delete  ← priority · size · repo
🗑 Dropped  1 · x discard · u reopen
📦 Done  42 · A to open
```

Colour is the whole signal: the coloured groups want you, the colourless ones
do not. Group-specific keys ride in the group header; the footer stays the
universal set. The second header line is always the budget forecast
(`session 42% · resets 02:00 (+3h10m) · headroom 43% ≈5 tasks`).

| Key | Action |
|---|---|
| `1` `2` | Tasks / Config tab |
| `j k` / arrows | move the cursor |
| `n` | new task (repo → title → size, then `$EDITOR` for the prompt) |
| `d` | promote review → done (done moves to the archive) |
| `a` | answer an asking task (typed into its pane, which resumes it) |
| `r` | retry (review / failed; resets the attempt budget) |
| `J` | jump to the task's Herdr pane |
| `o` | reopen the task's Claude session (`claude --resume`) |
| `e` | edit the prompt (or the config) in `$EDITOR` (queued only) |
| `[` `]` | move a queued task earlier / later in the queue |
| `x` | delete a queued task, cancel a live one, discard a dropped branch (confirmed) |
| `u` | reopen a dropped task |
| `A` | fold / unfold the done archive |
| `Enter` / `Esc` | detail / back |
| `g` | from the detail view, jump to the task's Herdr pane |
| `?` / `q` | help / quit |

Ink cannot scroll, so anything past the last row would simply be gone: the list
budgets its rows explicitly and says what it dropped (`… +N more`). Being one
vertical column, it works unchanged on a narrow terminal.

One caveat on `a`: it sends literal text. If the agent asked via an option
menu, jump to the pane (`J`) instead.

### Finishing a task

A task in review is yours to promote. Besides `d` in the TUI, you can finish it
**from the agent's own pane**:

```sh
!collie done          # in Claude's input box; ! runs a shell command
```

It resolves the task from `$COLLIE_TASK_ID` or the focused Herdr pane, so it
needs no id. It is idempotent (already done: nothing happens), and a task still
running goes to done via review — the human looking at the pane knows more than
the completion callback does.

`collie done --close` also tears the task down:

| | Behaviour |
|---|---|
| worktree task | `worktree.remove` — checkout deleted, pane and workspace closed, **branch kept** |
| non-worktree task | the pane is closed |
| uncommitted changes | nothing happens; the count is reported |

`[done] close = true` makes that the default.

### Cleaning up

```sh
collie gc [--dry-run] [--force]
```

For done and failed tasks, it removes clean worktree checkouts and deletes
**only branches already merged into HEAD** (`git branch -d`, so git itself
refuses unmerged work). Tracked changes stop it dead, `--force` included;
untracked files only need `--force`.

```
✓ t-20260809-6b40  worktree removed; deleted merged branch collie/t-MERGED
· t-20260809-eeaa  worktree removed; kept collie/t-AHEAD: not merged (1 commit(s) ahead of HEAD)
1/2 cleaned
```

A task is only reported while something collectable survives — a branch a human
already deleted drops out of the output instead of reappearing forever.

### CLI reference

```
collie task add --repo <path> --title <t> [--size S|M|L] [--priority N]
                [--no-worktree] [--permission-mode <m>] [--prompt <text>]
collie task list [--status s1,s2] [--json]
collie task show <id>
collie task queue|retry|cancel|done <id>
collie task complete <id> --summary "<text>"
collie task fail <id> --reason "<text>" [--retryable]

collie done [<id>] [--close]     # review -> done, from anywhere
collie gc [--dry-run] [--force]

collie dispatcher run [--once] [--verbose] | status
collie dispatcher install | restart | uninstall      (launchd)

collie linear sync [--dry-run] | status

collie new [--popup]             # the capture form alone, for a popup binding
collie tui
collie doctor
collie hook <name>               # internal: called by the generated Claude hooks
```

---

## Development

```sh
bun test           # 253 tests: store locking + archive, herdr client (fake
                   # socket), quota gate incl. burn-down, presence, forecast,
                   # schedule windows, reset parser, repo discovery, git
                   # helpers, Linear plan + sync (fake API), TUI render
bunx tsc --noEmit  # strict
```

Contributor notes — wire quirks, invariants, testing conventions — live in
[CLAUDE.md](CLAUDE.md).

Monorepo (bun workspaces): `packages/core` (store, Herdr client, quota,
Linear), `packages/cli` (dispatcher, hooks, task commands), `packages/tui`
(Ink: task list + config).

Runtime data lives in `~/.collie/`, overridable with `COLLIE_HOME` — set it to
a temp directory for any experiment, since a real dispatcher runs against the
default. `COLLIE_DEBUG=1` logs raw socket frames; `COLLIE_CCUSAGE_BIN` and
`COLLIE_LINEAR_API_URL` point the usage estimator and the Linear client at
fakes.

## Limitations

- Cancel never kills panes (forensics-friendly; close them in Herdr).
- Weekly quota is estimated as a rolling 7-day sum, not Anthropic's actual
  weekly reset boundary.
- One dispatcher per machine; no task dependencies or DAGs; no auto-PR from
  worktrees. `collie gc` deletes only branches already merged into HEAD —
  merging is left to the human.
- Nothing is written back to Linear when a task finishes; the issue is left in
  its started state for a human to close.
