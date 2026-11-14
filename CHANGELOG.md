# Changelog

All notable changes to collie. Format: [Keep a Changelog](https://keepachangelog.com/),
versions follow [SemVer](https://semver.org/). `collie update` prints the
sections between your old and new version, so keep the `## [X.Y.Z] - date`
heading shape.

## [Unreleased]

## [0.4.0] - 2026-11-14

### Added
- A review task whose pull request is merged into the repository's default
  branch now moves to done on its own, the same way a branch merged into HEAD
  already did. This covers squash and rebase merges (where the branch never
  becomes part of main) and merges on GitHub that no local fetch has brought in
  yet. The dispatcher re-checks a review task's PR with `gh` at most every 10
  minutes. A PR merged into any other branch does not count, and running or
  blocked tasks are left alone until they reach review. Tasks closed this way
  are no longer listed as 🗑 Dropped.

## [0.3.0] - 2026-11-12

### Added
- `skills/collie`: a Claude Code skill covering the agent-facing CLI — when work
  suits an unattended run, how to write its prompt, and how to register and
  check tasks. Link it into `~/.claude/skills` (see the README).
- A new task can start right away instead of waiting for the schedule window:
  the capture form (TUI `n` and `collie new`) ends with a `start:` step
  (`in window` by default, or `now`), and `collie task add` takes `--now`. It is
  the same start-now the task list's `s` already offered, so it skips the
  schedule, presence, WIP and quota gates but still waits out a real limit hit.

### Changed
- herdr workspaces, tabs and panes that collie creates are now labelled with
  the task's title instead of its id (`t-20261109-a3f2`), so the sidebar says
  which task each one is. Titles are capped at 40 characters. The agent name is
  still the id, because herdr only allows `[a-z0-9_-]` there. Panes that are
  already running keep their old labels.

### Fixed
- `collie --help` now lists `task add --model`.
- `[done] close = true` now applies to `d` in the TUI too, not only to
  `collie done`: finishing a task from the TUI removes its worktree (or closes
  its pane) instead of leaving herdr workspaces to pile up. (#1)
- A task whose PR was merged on GitHub no longer shows as 🗑 Dropped just
  because the local checkout has not been pulled. Merged now means contained in
  HEAD *or* in origin's default branch (`origin/HEAD`, as last fetched), the same
  ref dispatch forks from — so a local main lagging behind it made every task
  branch look unmerged from birth. The same check lets a `review` task whose
  branch landed upstream move to done on its own.
- A branch with no commits of its own (e.g. the agent shipped through a branch
  of another name) is no longer reported as dropped.

## [0.2.0] - 2026-10-24

### Added
- `collie update [--check] [--now]`: fast-forwards the collie checkout to the
  newest `vX.Y.Z` release tag on origin, runs `bun install` when `bun.lock`
  changed, restarts the launchd dispatcher, and prints these notes. Refuses on
  uncommitted changes, a non-default branch, or running tasks (`--now`
  overrides the last).
- Release notices: once a day the dispatcher asks origin for release tags
  (`git ls-remote`, read-only) and the TUI header shows
  `↑ vX.Y.Z · collie update` when a newer one exists. Quiet on a development
  checkout (feature branch or uncommitted changes).
- Code-drift detection: `dispatcher.json` records the commit the dispatcher
  booted on. The launchd dispatcher restarts itself onto new code once the
  checkout's HEAD has moved and held still for a tick; a manual run only logs
  it. The TUI header flags a dispatcher or TUI running old code, and
  `collie dispatcher status` / `collie doctor` show it.
- `collie doctor` reports the collie version, update availability, dispatcher
  drift, and config sections your `config.toml` predates.

### New config section
- `[update]` — `check = true` (default on). Your existing `config.toml` does
  not get it automatically; defaults apply until you add it. Set
  `check = false` to stop the daily `git ls-remote`.
