# agent-hub

Kanban-style task queue for Claude Code sessions, orchestrated through
[Herdr](https://herdr.dev). Queue up coding tasks ahead of time; a dispatcher
drains them into fresh Herdr panes whenever your token quota has headroom —
preferring the night hours you configure.

## クイックスタート（日本語）

```sh
# 1. 依存関係と CLI
bun install
# ~/.local/bin に agent-hub シムを置く（または bun link）
printf '#!/bin/sh\nexec %s %s "$@"\n' "$(which bun)" "$PWD/packages/cli/src/index.ts" \
  > ~/.local/bin/agent-hub && chmod +x ~/.local/bin/agent-hub

# 2. 環境チェック（herdr ソケット / claude / ccusage）
agent-hub doctor

# 3. タスクを積む（--prompt を省略すると $EDITOR が開く）
agent-hub task add --repo ~/dev/projects/myapp --title "flaky テストを直す" --queue

# 4. ディスパッチャを常駐させる（launchd）
agent-hub dispatcher install

# 5. カンバン TUI（Herdr のペイン内で開くのがおすすめ）
agent-hub tui
```

タスクは `~/.agent-hub/tasks/*.md`（YAML frontmatter + 本文=プロンプト）。
`~/.agent-hub/config.toml` で WIP 制限・深夜ウィンドウ・トークン予算を調整します。
既定では 00:00–07:00 が full モード、それ以外は conservative（小さめのタスクのみ、
予算の 35% まで）です。

**予算のキャリブレーション**: 実際にリミットに当たると、Claude 自身が表示する
リセット時刻を読み取って自動的に休止し、その時点のブロック消費量を
`learnedBlockCeiling` として記録します。ダッシュボードに表示されるこの値を見て
`block_budget_tokens` を調整してください。

## How it works

```
task .md files ──> dispatcher (launchd, 30s tick)
                      │  gates: schedule window → blockedUntil → WIP → quota (ccusage)
                      ▼
                Herdr socket API: worktree.create → agent.start (claude
                --settings hooks) → inject one-line prompt pointer → Enter
                      │
                claude session ──hooks──> task file heartbeats / blocked / requeue
                      └── final action: `agent-hub task complete <id> --summary …`
                          → review column (human promotes to done in the TUI)
```

Key design decisions, learned the hard way:

- **Completion = explicit CLI callback**, not Herdr's `done` status (cleared
  when a human views the tab) and not the Stop hook (fires after every
  response). A watchdog routes forgotten callbacks to review after
  `idle_grace_min`, so nothing hangs silently.
- **Prompt injection is a one-line pointer** to `runs/<id>/prompt.md` —
  multiline pastes into the claude input box are a trap. The dispatcher
  verifies the echo (whitespace-normalized, panes hard-wrap) before Enter.
- **Startup dialogs**: claude's folder-trust dialog reads as `blocked`/
  `unknown`; the dispatcher auto-confirms it (queueing a task for a repo IS
  the trust decision) and only treats a live `idle` from `agent.get` as ready.
- **No socket multiplexing**: Herdr error frames can lose the request id, so
  the client does one request per connection, plus one dedicated subscribe
  connection per running pane.
- **Sidebar reporting uses `pane.report_metadata` only** — reporting semantic
  agent state would feed back into the `agent_status` the dispatcher itself
  reads.
- **Limit hits**: scraped from the pane (`You've hit your session limit ·
  resets 3:45pm`); the printed reset time becomes a hard dispatch stop
  (+ jitter) and the task requeues without burning an attempt.

## CLI

```
agent-hub task add|list|show|queue|backlog|retry|cancel|done|complete|fail
agent-hub dispatcher run [--once] [--verbose] | status | install | uninstall
agent-hub tui
agent-hub doctor
agent-hub hook <name>        # internal: called by claude hooks
```

## Development

```sh
bun test          # 44 tests: store concurrency, herdr client (fake socket),
                  # gate math, schedule windows, reset parser, TUI render
bunx tsc --noEmit
```

Monorepo: `packages/core` (store, herdr client, quota), `packages/cli`
(dispatcher, hooks, task commands), `packages/tui` (Ink kanban).

Runtime data lives in `~/.agent-hub/` (override with `AGENT_HUB_HOME`).
`AGENT_HUB_DEBUG=1` logs raw socket frames; `AGENT_HUB_CCUSAGE_BIN` overrides
the usage estimator (used by tests).

## v1 limitations

- Cancel never kills panes (forensics-friendly; close them in Herdr).
- Weekly quota is estimated as a rolling 7-day sum, not Anthropic's actual
  weekly reset boundary.
- One dispatcher per machine; no task dependencies/DAGs; no auto-PR from
  worktrees.
