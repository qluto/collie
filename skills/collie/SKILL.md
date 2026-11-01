---
name: collie
description: Queue work for an unattended Claude Code session that runs later (typically overnight) via the collie CLI, and inspect queued or finished tasks. Use when the user wants work done without them — "夜に回して", "寝てる間にやっておいて", "collie に積んで", "あとでやっておいて", "タスク登録して", "do this overnight", "queue this" — or when agreed follow-up work is self-contained, verifiable, and does not need the user present. Also use to check what ran: "collie の結果は", "昨夜のタスクどうなった".
---

# collie

collie is an unattended-work box: tasks go in during the day, a dispatcher runs
each one in its own Claude Code session when quota allows, and the human reviews
the results later. **A task in collie means "this runs without me".**

The usual job here is one call: decide the work fits, write a self-contained
prompt, run `collie task add`, report the id.

## Does this work fit?

Register it when all of these hold:

- **Self-contained** — a fresh session can do it from the prompt and the repo alone.
- **Decidable** — no human judgment needed midway, or the prompt settles it up front.
- **Verifiable** — the session can prove it worked (tests, typecheck, a build, a command).
- **Safe to leave on a branch** — the worst outcome is a diff someone declines.

Good fits: bug fixes with a reproduction, test coverage, refactors behind tests,
mechanical migrations, dependency bumps, docs, investigations that end in a written report.

Keep it out of collie and do it now, or say why, when it involves:

- UI or product decisions the user wants to see while they form
- Anything needing interactive login, a physical device, or the user's eyes
- Deploys, production data, sending messages, or other outward effects (fine
  only if the task stops at a PR)
- Unpushed work it depends on, unless that work is pushed first or the prompt names how to get it

**When to register without asking:** the user asked for it, or it is follow-up
work they already agreed should happen. A queued task costs nothing to remove.
**When to ask first:** something you noticed on your own that nobody requested —
offer it in one line instead of spending their quota.

## Register a task

```sh
collie task add \
  --repo "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")" \
  --title "Fix retry double-count in dispatcher" \
  --size M \
  --prompt="$(cat <<'EOF'
<the prompt>
EOF
)"
```

- **Always pass the prompt.** Without it `task add` opens `$EDITOR` and hangs.
- **Always use `--prompt=` with the equals sign.** The space form crashes if the
  prompt begins with `-` (a markdown list, for instance).
- **Quote the heredoc** (`<<'EOF'`) so `$VARS` and backticks survive untouched.
- `--repo` must be a git checkout, and should be the **main** repo. The snippet
  above resolves it from anywhere, including from inside a worktree.

| Flag | Meaning | Default |
| --- | --- | --- |
| `--size S\|M\|L` | Estimated token cost. Feeds the quota gates. Conservative windows skip `L`. | `M` |
| `--priority N` | Queue order only, **lower runs first**. | `100` |
| `--model <name>` | Passed to `claude --model`. Set only if the user asked. | config, else claude's default |
| `--no-worktree` | Run in the repo checkout itself, on whatever is checked out there. | worktree |
| `--permission-mode <m>` | Leave unset. `bypassPermissions` wedges at a startup dialog and `manual` waits for a human. | `auto` |

Size guide: **S** is one file or a small fix, **M** is a normal bug or feature,
**L** is a multi-package change or a long investigation.

`task add` prints `created <id> (queued)`. Tell the user the id and title, and
that `collie task cancel <id>` removes it. There is no edit command: to change a
queued task, cancel it and add it again.

## Writing the prompt

The session starts with none of this conversation. Nobody will answer it at
3am: a question parks the task until morning.

What it starts from:

- A fresh worktree on branch `collie/<id>`, normally forked from
  `origin/<default>` as fetched at dispatch. **Uncommitted, unpushed and
  other-branch work is not there.**
- The repo's own `CLAUDE.md`, but not this session's memory or context.
- A completion footer collie appends itself. Do not write one.

The prompt should state:

1. **Goal** — the outcome, not a pointer like "the bug we discussed".
2. **Context** — paths, error text, reproduction steps, decisions already made
   and why. Copy these in; the conversation will be gone.
3. **Done means** — the commands that must pass.
4. **Deliverable** — commit on the branch, push and open a PR, or a report at a
   stated path. Nothing is pushed unless the prompt says so.
5. **Boundaries** — what not to touch, and how to resolve the likely ambiguity:
   "If X is unclear, choose Y and note it in the summary."

## What happens next

The dispatcher decides when it runs: schedule window, presence, quota and WIP
all gate it, so queued does not mean running now or even tonight.

```text
queued → running → review → done
            ↓↑        ↓
          blocked   (queued, to redo)
            ↓
          failed → queued (retry)
```

`review` means the session reported finished and a human should look.
`blocked` means it is waiting on a question. Merging a task's branch moves it
from `review` to `done` automatically.

## Look at the queue

```sh
collie task list                                # working set; done is excluded
collie task list --status review,failed --json  # add `done` to search the archive
collie task show <id>                           # full JSON, prompt included
collie dispatcher status                        # running? mode, last decision, counts
collie doctor                                   # environment check
```

In the JSON, `run.resultSummary`, `run.failureReason` and `run.question` hold
the outcome; `branch` and `run.prUrl` say where the work is. An unknown `--status`
value prints `(no tasks)` rather than an error, so check the spelling.

## Change a task

| Command | Effect |
| --- | --- |
| `collie task cancel <id>` | Queued: deletes it. Running/blocked/review: moves to `failed`. |
| `collie task retry <id>` | `failed` or `review` → queued, with attempts reset. |
| `collie task queue <id>` | Same move, attempts kept. Prefer `retry`. |

An illegal status change exits non-zero with a stack trace; that is an
`IllegalTransitionError`, not a crash in collie.

**Leave to the human** unless they ask: `collie done`, `collie task done`,
`collie gc`, `collie update`, and `collie dispatcher install|restart|uninstall`.
Accepting work and deleting branches are their review.

## If you are inside a collie task

`$COLLIE_TASK_ID` is set. Finish with the exact commands from the prompt's
completion footer (`task complete` or `task fail`). Never run `collie done` —
with no id it targets your own task and skips the human review. Queue follow-up
tasks only if your prompt asks for them.

## Not available from the CLI

Editing a queued task, answering a blocked task's question, reordering after
creation, and reopening a finished session are TUI-only (`collie tui`). If a task
is blocked, tell the user; do not try to answer it through the pane.

Issues can also arrive through Linear when `[linear]` is configured:
`collie linear status`, and `collie linear sync --dry-run` to preview without writing.
