# collie 🐑🐑🐕

An unattended-work box for Claude Code sessions, orchestrated through
[Herdr](https://herdr.dev) — the herder's sheepdog. Toss coding tasks in by
day; a dispatcher burns your leftover token quota on them at night (presence ×
real limit percentages × burn-down near the session reset); harvest the
results in the morning — approve, answer the questions your agents got stuck
on, retry the failures.

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
collie task add --repo ~/dev/projects/myapp --title "flaky テストを直す"

# 4. ディスパッチャを常駐させる（launchd）
collie dispatcher install

# 5. TUI — 朝の収穫ビュー + ボード（Herdr のペイン内で開くのがおすすめ）
collie tui
```

タスクは `~/.collie/tasks/*.md`（YAML frontmatter + 本文=プロンプト）。
`~/.collie/config.toml` で WIP 制限・深夜ウィンドウ・トークン予算を調整します。
`[repos] roots = ["~/dev/projects", "~/ghq/github.com"]` を設定すると、TUI の
新規タスクフォームでリポジトリを一覧から選べます（2階層まで探索するので
ghq 形式の org 階層にも対応。入力でフィルタ、↑↓で選択、自由入力も可）。
既定では 00:00–07:00 が full モード、それ以外は conservative（小さめのタスクのみ、
予算の 35% まで）です。

**1日のサイクル**: collie に入れる = 「私がいなくてもいい」と宣言したこと。
昼に投函（repo・タイトル・サイズの3問、10秒）→ 夜に自動投入（presence × クォータ
残量で判断、reset 間際は burn-down で余り予算を使い切る）→ 朝に収穫（Harvest
ビューで承認・質問への返答・retry）。タスクの軸は `size`（S/M/L = トークン消費の
見積もり）と `priority`（キューの並び順のみ）の2つだけです。

**burn-down**: セッション予算は reset で消滅するので、`[quota.burn_down]`
（既定 on）により reset まで `window_min` 分を切った full ウィンドウでは cap が
`fraction`（既定 0.95）まで緩みます。ヘッダーに `⌛ burn-down` と表示されます。

**presence**（既定 off）: `[presence] enabled = true` にすると macOS の入力アイドル
時間がゲート信号になります。人がマシンの前にいる間はモードが `when_present`（既定
`paused`）で頭打ちになります。これは full ウィンドウだけでなく**すべてのウィンドウ
に効く上限**です（full だけを降格していた頃は、日中の conservative なウィンドウでは
presence が何もせず、目の前で作業中のユーザーにタスクが投入されていました）。
`absent_upgrade = true` なら長時間不在のマシンはウィンドウ外でも full に昇格します
（paused は決して昇格しません）。上限が効かなかった場合も
`presence: human at keyboard (already conservative)` と decision に残るので、
「on なのに何もしていない」状態が off と見分けられます。

**パーミッションモード**: 既定は `auto`（claude 自身の既定でもある）。分類器が
低リスクなツール呼び出しだけを実行し、危険なものはブロックするので無人実行に向い
ています。`bypassPermissions` は起動時に確認ダイアログが出ますが**ディスパッチャは
これを自動確認しません**（フォルダ信頼ダイアログとは違い、意図的なゲートなので）。
無人で走らせるタスクに指定するとダイアログの前で固まります。

**レビューして done にする**: review 列のタスクは人間が中身を見るまで done になりません。
TUI の `d` のほかに、**エージェントのペインに居たまま** done にできます:

```sh
!collie done          # claude の入力欄で。! はモデルのターンを使わずシェル実行
```

herdr のキーバインドからも呼べます（`~/.config/herdr/config.toml`）。フォーカス中の
ペインからタスクを逆引きするので、ボードに戻る必要がありません:

```toml
[[keys.command]]
key = "prefix+d"
type = "shell"
command = "~/.local/bin/collie done"   # 絶対パスで書くこと
```

`type = "shell"` は detached 実行で標準出力が誰にも見えないため、結果は herdr の
通知で返します（`[ui.toast] delivery` が `off` だと通知自体が出ないので注意）。
確実な合図としてペイン名も `✓ <task id>` に変わります。押し間違いに強いよう冪等
（done 済みなら何もしない）で、まだ running のタスクは review を経由して done に
します（ペインを見ている人間のほうが完了コールバックより情報を持っているため）。

**後片付け**: `collie done --close` を付けると、そのタスクの店じまいまでやります。

| | 動作 |
|---|---|
| worktree タスク | `worktree.remove` — チェックアウト削除・ペイン/ワークスペース自動クローズ・**ブランチは温存** |
| worktree なし | ペインを閉じるだけ |
| 未コミットあり | 何もせず件数を報告（herdr 自身も dirty な worktree を拒否する） |

`[done] close = true` で既定にできます（既定は `false`）。

溜まったものは `collie gc` でまとめて片付きます。done/failed のタスクについて、
クリーンな worktree チェックアウトを外し、**HEAD にマージ済みのブランチだけ**を
削除します（`git branch -d` なので未マージは git 自身が拒否）。`--dry-run` あり。

```
✓ t-20260809-6b40  worktree removed; deleted merged branch collie/t-MERGED
· t-20260809-eeaa  worktree removed; kept collie/t-AHEAD: not merged (1 commit(s) ahead of HEAD)
1/2 cleaned
```

**クォータは実測値**: Anthropic 自身が持つ消費率（claude の `/usage` パネルと同じ
数字）を `GET /api/oauth/usage` から10分に1度取得し、`$COLLIE_HOME/limits.json`
にキャッシュしてディスパッチャと TUI で共有します。`fraction_full` /
`fraction_conservative` はこのパーセンテージに対する上限として解釈されます。

未公開エンドポイントなので取得できないこともあります。その場合は ccusage の
トークン推定（`block_budget_tokens` ほか）に自動フォールバックします。認証は
macOS Keychain にある claude の OAuth トークンを**読むだけ**で、期限切れなら
「取得不可」として扱います（リフレッシュは認証情報のローテーションになるため
行いません）。

## How it works

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
                          → review column (a human promotes it to done)
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
- **Questions don't kill the night**: a task blocked on a question stops
  counting toward WIP (it burns no tokens); the hook message plus a scraped
  pane tail land on the task for the morning harvest, and `asking_limit`
  stops the pile from growing unbounded. One caveat: `a` sends literal text —
  if the agent asked via an option menu, jump to the pane (`J`) instead.

## TUI

`collie tui` は vim/htop と同じ全画面（オルタネートスクリーン）で動き、終了時に
元のシェル画面を復元します。日本語 IME に対応：変換中テキストは入力欄のカーソル
位置にインライン表示され、複数文字の一括確定でも文字が欠けません。

デフォルトタブは **Harvest（収穫）** — 夜が生んだ結果を朝に回収する画面です。
✅ Review（diff 要約つき）/ ❓ Asking（エージェントの質問をインライン表示）/
✗ Failed の3グループが並び、2行目のヘッダーには常に予算予報
（`session 42% · resets 02:00 (+3h10m) · headroom 43% ≈5 tasks`）が出ます。

| キー | 動作 |
|---|---|
| `1` `2` `3` | Harvest / Board / Config タブ |
| `j k` / 矢印 | カード移動 |
| `n` | 新規タスク（repo → タイトル → サイズの3問 → $EDITOR でプロンプト） |
| `d` | Review → Done 昇格（done はアーカイブへ移動） |
| `a` | Asking のタスクに返答（そのペインに送信して再開） |
| `r` | retry（Review / Failed、attempts リセット） |
| `J` | そのタスクの Herdr ペインへジャンプ（Harvest）/ 優先度並び替え（Board） |
| `e` | プロンプト（または config）を $EDITOR で編集（queued のみ） |
| `x` | queued は削除、実行中はキャンセル（確認あり） |
| `Enter` / `Esc` | 詳細表示 / 戻る |
| `g` | 詳細画面から、そのタスクの Herdr ペインへジャンプ |
| `?` / `q` | ヘルプ / 終了 |

Board は Queued / Running / Asking / Review / Failed の5レーン（Done はアーカイブ
されるためレーンなし）。横幅が 70 桁未満（moshi 経由のモバイル等）では、レーンを
横に並べる代わりに**縦に積む**表示へ自動で切り替わります。空のレーンは畳まれ、
画面に入り切らない分は `… +N` や末尾の要約行として明示されます（Ink はスクロール
できないため、行数は明示的に配分しています）。

## CLI

```
collie task add|list|show|queue|retry|cancel|done|complete|fail
collie done [<id>] [--close]   # review -> done from the agent's own pane
collie gc [--dry-run]          # finished tasks: worktrees + merged branches
collie dispatcher run [--once] [--verbose] | status | install | restart | uninstall
                          # restart: pick up new code (install re-renders the
                          # plist and also restarts; restart just kickstarts)
collie tui
collie doctor
collie hook <name>        # internal: called by claude hooks
```

## Development

```sh
bun test          # 152 tests: store concurrency + archive, herdr client
                  # (fake socket), gate math incl. burn-down, presence,
                  # forecast, schedule windows, reset parser, repo discovery,
                  # git diff/worktree helpers, TUI render + display width
bunx tsc --noEmit
```

Contributor notes (wire quirks, invariants, testing conventions) live in
[CLAUDE.md](CLAUDE.md).

Monorepo: `packages/core` (store, herdr client, quota), `packages/cli`
(dispatcher, hooks, task commands), `packages/tui` (Ink: harvest view + board).

Runtime data lives in `~/.collie/` (override with `COLLIE_HOME`).
`COLLIE_DEBUG=1` logs raw socket frames; `COLLIE_CCUSAGE_BIN` overrides
the usage estimator (used by tests).

## v1 limitations

- Cancel never kills panes (forensics-friendly; close them in Herdr).
- Weekly quota is estimated as a rolling 7-day sum, not Anthropic's actual
  weekly reset boundary.
- One dispatcher per machine; no task dependencies/DAGs; no auto-PR from
  worktrees. `collie gc` deletes only branches already merged into the repo's
  HEAD — merging is left to the human.
