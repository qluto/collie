# Changelog

All notable changes to collie. Format: [Keep a Changelog](https://keepachangelog.com/),
versions follow [SemVer](https://semver.org/). `collie update` prints the
sections between your old and new version, so keep the `## [X.Y.Z] - date`
heading shape.

## [Unreleased]

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
