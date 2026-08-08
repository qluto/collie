# collie 🐑🐑🐕

Kanban-style task queue for Claude Code sessions, orchestrated through
[Herdr](https://herdr.dev) — the herder's sheepdog. Queue up coding tasks
ahead of time; a dispatcher drains them into fresh Herdr panes whenever your
token quota has headroom — preferring the night hours you configure.

## クイックスタート（日本語）

```sh
# 1. 依存関係と CLI
bun install
# ~/.local/bin に collie シムを置く（または bun link）
printf '#!/bin/sh\nexec %s %s "$@"\n' "$(which bun)" "$PWD/packages/cli/src/index.ts" \
  > ~/.local/bin/collie && chmod +x ~/.local/bin/collie

# 2. 環境チェック（herdr ソケット / claude / ccusage）
collie doctor

# 3. タスクを積む（--prompt を省略すると $EDITOR が開く）
collie task add --repo ~/dev/projects/myapp --title "flaky テストを直す" --queue

# 4. ディスパッチャを常駐させる（launchd）
collie dispatcher install

# 5. カンバン TUI（Herdr のペイン内で開くのがおすすめ）
collie tui
```

タスクは `~/.collie/tasks/*.md`（YAML frontmatter + 本文=プロンプト）。
`~/.collie/config.toml` で WIP 制限・深夜ウィンドウ・トークン予算を調整します。
`[repos] roots = ["~/dev/projects", "~/ghq/github.com"]` を設定すると、TUI の
新規タスクフォームでリポジトリを一覧から選べます（2階層まで探索するので
ghq 形式の org 階層にも対応。入力でフィルタ、↑↓で選択、自由入力も可）。
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
                      └── final action: `collie task complete <id> --summary …`
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

## TUI

`collie tui` は vim/htop と同じ全画面（オルタネートスクリーン）で動き、終了時に
元のシェル画面を復元します。日本語 IME に対応：変換中テキストは入力欄のカーソル
位置にインライン表示され、複数文字の一括確定でも文字が欠けません。

| キー | 動作 |
|---|---|
| `1` `2` `3` | Board / Dashboard / Config タブ |
| `h l j k` / 矢印 | 列・カード移動 |
| `n` | 新規タスク（repo は一覧から選択 or 自由入力 → $EDITOR でプロンプト） |
| `space` | Backlog ↔ Queued |
| `J` `K` | Queued 内の優先度並び替え |
| `d` / `r` | Review→Done 昇格 / 再キュー |
| `e` | プロンプト（または config）を $EDITOR で編集 |
| `x` | キャンセル（確認あり。ペインは残す） |
| `f` | Done ↔ Failed 列切替 |
| `Enter` / `Esc` | 詳細表示 / 戻る |
| `?` / `q` | ヘルプ / 終了 |

## CLI

```
collie task add|list|show|queue|backlog|retry|cancel|done|complete|fail
collie dispatcher run [--once] [--verbose] | status | install | uninstall
collie tui
collie doctor
collie hook <name>        # internal: called by claude hooks
```

## Development

```sh
bun test          # 50 tests: store concurrency, herdr client (fake socket),
                  # gate math, schedule windows, reset parser, repo discovery,
                  # TUI render + display width
bunx tsc --noEmit
```

Contributor notes (wire quirks, invariants, testing conventions) live in
[CLAUDE.md](CLAUDE.md).

Monorepo: `packages/core` (store, herdr client, quota), `packages/cli`
(dispatcher, hooks, task commands), `packages/tui` (Ink kanban).

Runtime data lives in `~/.collie/` (override with `COLLIE_HOME`).
`COLLIE_DEBUG=1` logs raw socket frames; `COLLIE_CCUSAGE_BIN` overrides
the usage estimator (used by tests).

## v1 limitations

- Cancel never kills panes (forensics-friendly; close them in Herdr).
- Weekly quota is estimated as a rolling 7-day sum, not Anthropic's actual
  weekly reset boundary.
- One dispatcher per machine; no task dependencies/DAGs; no auto-PR from
  worktrees.
