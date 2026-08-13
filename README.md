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

Putting a task into collie is a declaration: **this runs without me.**

### The daily loop

| | |
|---|---|
| **Day** | Toss a task in — three questions (repo, title, size), then `$EDITOR` for the prompt. Ten seconds. |
| **Night** | The dispatcher picks tasks off the queue when the schedule, your absence and the remaining quota all agree. |
| **Morning** | Collect: approve, answer, retry. |

A task has two axes, and they never mean the same thing:

- **`size`** (S/M/L) — an estimate of token cost. It gates: a conservative
  window will not pick up an oversized task.
- **`priority`** — queue order, nothing else.

### Quota from the source, not from a guess

The gate reads Anthropic's own consumption percentages — the numbers Claude
Code shows in its `/usage` panel — at most once every 10 minutes, cached so the
dispatcher and the TUI share one call. `fraction_full` and
`fraction_conservative` are caps on *those* percentages. When they cannot be
read, the gate falls back to ccusage's token estimates. Your Claude credentials
are only ever read, never refreshed.

**Burn-down** (`[quota.burn_down]`, on by default): session budget evaporates at
the reset, so a full window close to one may spend up to `fraction` (0.95)
instead of the standing cap. The TUI header shows `⌛ burn-down` while it
applies.

### Presence — not while you are here

Off by default. With `[presence] enabled = true`, macOS input-idle time becomes
a gate signal: while you are at the machine the mode is capped at
`when_present` (default `paused`), in **every** window rather than only the
full ones. `absent_upgrade = true` lets a long-idle machine run full outside
its windows; `paused` never upgrades. A cap that changes nothing still reports
itself, so "on but idle" is distinguishable from "off".

### Isolation and review

Each task runs in its own git worktree, on its own `collie/<id>` branch, in its
own Herdr pane. Nothing reaches `done` until a human has looked: a finished
session lands in **review**, and you promote it.

**Merging the branch is the review.** A task in review whose branch is already
contained in HEAD is promoted to done for you. What stays in done with an
*unmerged* branch is therefore work you looked at and dropped: the TUI shows it
as `🗑 Dropped`, where you can discard the branch or reopen the task. Merging a
dropped task's branch later simply un-drops it.

A task's repo is validated **when the task is created** — it must exist, be a
directory, and be a git checkout. The capture form will not leave the repo
field, and `task add` stops before opening `$EDITOR`.

### Questions don't kill the night

A task blocked on a question stops counting toward the WIP limit, so one stuck
session cannot starve the queue. The agent's question is captured onto the task
for the morning, and `asking_limit` caps how many may pile up before dispatch
pauses.

### Linear import (optional, off by default)

Issues carrying a marker label **and assigned to you** become queued tasks,
polled every `poll_interval_min` (default 5). A whole team can share one board
and one label; assignment is what keeps two people's machines from racing for
the same issue. `assignee = "any"` opts out.

An issue that carries the label but is not yours is skipped with a reason
(`assigned to Sam`, `unassigned — assign it to yourself…`), so the mistake
everyone makes — labelling an issue and forgetting to assign it — is visible
rather than silent.

**Which repo an issue is about** is resolved most-specific-first:

1. a repo label on the issue — a child of the Linear label **group** `repo`, or
   a flat `repo:myapp` label
2. the issue's **project name**
3. the **team key**

At each step the name is looked up in `[linear.repos]`, then matched by
directory name against the checkouts under `[repos] roots`. A Linear project
named like its checkout needs **no configuration at all**; the table is only
for when the two names disagree. Every import reports which step answered
(`via project myapp`).

A repo label that matches nothing skips the issue rather than falling back to
the team's repo. An unmapped project does fall back, so a team entry means
"everything else goes here".

Issues that are passed over always say why, and `collie linear sync --dry-run`
shows the whole plan without writing anything:

```
would import  ENG-42  fix the flaky login test  -> ~/dev/projects/myapp  (via project myapp)
skip    ENG-43  state "In Progress" is already under way
skip    OPS-7   no repo named OPS (repo/… label, project, team) — add it to [linear.repos] or rename to match a checkout
1 would be imported, 2 skipped (dry run: nothing written)
```

**The issue's status moves when the work starts, not when it was collected** —
an imported task may sit in the queue all evening. The dispatcher moves it the
moment the session starts and comments with the task id and branch name; if
Linear is unreachable the session runs anyway. An issue is never collected
twice, and Linear's priority becomes queue order (Urgent first).

### Permission modes

The default is `auto`, Claude Code's own default: low-risk tool calls run, the
rest are blocked. `bypassPermissions` shows a startup dialog that **the
dispatcher does not answer**, so a task using it will wedge in front of it.

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
tab shows both side by side (`00:00-07:00 full — any size`).

### 4. Run the dispatcher

```sh
collie dispatcher install     # launchd agent, starts immediately
collie dispatcher status
tail -f ~/.collie/logs/dispatcher.log
```

`collie dispatcher restart` picks up new code. Config edits need no restart —
they are reloaded on the next tick.

### 5. Optional: Linear

The API key is read from the macOS Keychain, never from `config.toml`:

```sh
security add-generic-password -s "collie-linear" -a "$USER" -w "lin_api_..."
```

```toml
[linear]
enabled = true
label = "collie"             # collect open issues carrying this label
assignee = "me"              # me|any — "me" keeps two people on one team apart
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
network calls to Linear and does not read the Keychain.

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

`type = "shell"` runs detached, so results come back as a Herdr notification
(nothing appears if `[ui.toast] delivery = "off"`) and the pane is renamed
`✓ <task id>`.

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

Colour is the signal: the coloured groups want you, the colourless ones do not.
Group-specific keys ride in the group header; the footer stays the universal
set. The second header line is always the budget forecast
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

The list fits itself to the terminal and says what it could not show
(`… +N more`), so it works unchanged on a narrow screen.

One caveat on `a`: it sends literal text. If the agent asked via an option
menu, jump to the pane (`J`) instead.

### Finishing a task

A task in review is yours to promote. Besides `d` in the TUI, you can finish it
**from the agent's own pane**:

```sh
!collie done          # in Claude's input box; ! runs a shell command
```

It resolves the task from `$COLLIE_TASK_ID` or the focused Herdr pane, so it
needs no id, and it is idempotent.

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
**only branches already merged into HEAD**. Tracked changes stop it, `--force`
included; untracked files only need `--force`.

```
✓ t-20260809-6b40  worktree removed; deleted merged branch collie/t-MERGED
· t-20260809-eeaa  worktree removed; kept collie/t-AHEAD: not merged (1 commit(s) ahead of HEAD)
1/2 cleaned
```

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
bun test
bunx tsc --noEmit
```

Contributor notes — wire quirks, invariants, testing conventions — live in
[CLAUDE.md](CLAUDE.md).

Monorepo (bun workspaces): `packages/core` (store, Herdr client, quota,
Linear), `packages/cli` (dispatcher, hooks, task commands), `packages/tui`
(Ink: task list + config).

Runtime data lives in `~/.collie/`, overridable with `COLLIE_HOME` — point it
at a temp directory for any experiment, since a real dispatcher runs against
the default.

## Limitations

- Cancel never kills panes (close them in Herdr).
- Weekly quota is estimated as a rolling 7-day sum, not Anthropic's actual
  weekly reset boundary.
- One dispatcher per machine; no task dependencies or DAGs; no auto-PR from
  worktrees. `collie gc` deletes only branches already merged into HEAD —
  merging is left to you.
- Nothing is written back to Linear when a task finishes; the issue is left in
  its started state for you to close.

## License

MIT — see [LICENSE](LICENSE).
