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

# 5. TUI — タスク一覧（Herdr のペイン内で開くのがおすすめ）
collie tui
```

タスクは `~/.collie/tasks/*.md`（YAML frontmatter + 本文=プロンプト）。
`~/.collie/config.toml` で WIP 制限・深夜ウィンドウ・トークン予算を調整します。
`[repos] roots = ["~/dev/projects", "~/ghq/github.com"]` を設定すると、TUI の
新規タスクフォームでリポジトリを一覧から選べます（2階層まで探索するので
ghq 形式の org 階層にも対応。入力でフィルタ、↑↓で選択、自由入力も可）。
既定では 00:00–07:00 が full モード（サイズ不問）、それ以外は conservative
（`conservative_max_size` 以下＝既定では M まで、予算も 35% まで）です。モード名は
設定ファイルの語ですが、画面のヘッダーには**何を拾うか**が出ます — `● any size` /
`● up to M` / `● paused`。Config タブは両方を並べて表示する唯一の場所です
（`00:00-07:00 full — any size`）。

**1日のサイクル**: collie に入れる = 「私がいなくてもいい」と宣言したこと。
昼に投函（repo・タイトル・サイズの3問、10秒）→ 夜に自動投入（presence × クォータ
残量で判断、reset 間際は burn-down で余り予算を使い切る）→ 朝に回収（Tasks
画面で承認・質問への返答・retry）。タスクの軸は `size`（S/M/L = トークン消費の
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
ペインからタスクを逆引きするので、TUI に戻る必要がありません:

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

**Linear 連携**（既定 off）: ラベルの付いた issue を自動でタスクに回収します。
外部システムなので `poll_interval_min`（既定5分）でポーリングし、30秒の dispatch
tick には乗せません。

```sh
# API キーは config.toml ではなく Keychain（Config タブは設定ファイルを全文表示するため）
security add-generic-password -s "collie-linear" -a "$USER" -w "lin_api_..."
```

```toml
[linear]
enabled = true
label = "collie"             # このラベルが付いた open な issue を回収
poll_interval_min = 5
size = "M"                   # 取り込んだタスクのサイズ
start_state = ""             # 取り込み時にこの状態へ移す（"" = そのチームの最初の started 状態）
comment = true               # collie のタスクIDを issue にコメント

[linear.repos]
"ENG" = "~/dev/projects/myapp"   # Linear のチームキー -> ローカル repo
```

repo が引けないチームの issue は**回収せずスキップし、理由を必ず出します**（ラベルを
付けたのに何も起きない、が一番困るため）。`collie linear sync --dry-run` で何が起きるか
だけ確認できます:

```
would import  ENG-42  flaky ログインテストを直す  -> ~/dev/projects/myapp
skip    ENG-43  state "In Progress" is already under way
skip    OPS-7   no repo mapped for team OPS
1 would be imported, 2 skipped (dry run: nothing written)
```

二重回収は2重に防いでいます: ローカルの台帳（`linear.json`、書き戻しより先に記録）と、
Linear 側の状態そのもの（取り込み時に started へ動かし、started の issue は回収対象外）。
書き戻しは best-effort で、失敗してもタスクは残り警告だけが出ます。Linear の優先度は
キュー順に反映されます（Urgent が先頭、未設定は Normal 扱い）。`collie linear status`
で設定・キー・回収済み一覧を確認できます。

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
  pane tail land on the task, ready for the morning, and `asking_limit`
  stops the pile from growing unbounded. One caveat: `a` sends literal text —
  if the agent asked via an option menu, jump to the pane (`J`) instead.

## TUI

`collie tui` は vim/htop と同じ全画面（オルタネートスクリーン）で動き、終了時に
元のシェル画面を復元します。日本語 IME に対応：変換中テキストは入力欄のカーソル
位置にインライン表示され、複数文字の一括確定でも文字が欠けません。

タブは **Tasks** と **Config** の2枚だけ。Tasks はすべてのタスクを1本の縦リスト
にまとめた画面で、人が処理する順に並びます — 決断を待つ ✅ Review（diff 要約つき）
/ ❓ Asking（エージェントの質問をインライン表示）/ ❌ Failed、続いて何も要求しない
🏃 Running（ハートビート付き）/ ⏳ Queued（優先度・サイズ・repo）、最後に
🗑 Dropped と 📦 Done（`A` で開閉）。2行目のヘッダーには常に予算予報
（`session 42% · resets 02:00 (+3h10m) · headroom 43% ≈5 tasks`）が出ます。

グループ固有の操作はそのグループのヘッダーに書いてあります
（`⏳ Queued 3 · e edit · [ ] reorder · x delete`）。フッターは全体共通のキーだけ。

| キー | 動作 |
|---|---|
| `1` `2` | Tasks / Config タブ |
| `j k` / 矢印 | カード移動 |
| `n` | 新規タスク（repo → タイトル → サイズの3問 → $EDITOR でプロンプト） |
| `d` | Review → Done 昇格（done はアーカイブへ移動） |
| `a` | Asking のタスクに返答（そのペインに送信して再開） |
| `r` | retry（Review / Failed、attempts リセット） |
| `J` | そのタスクの Herdr ペインへジャンプ |
| `o` | そのタスクの claude セッションを再開（`claude --resume`） |
| `e` | プロンプト（または config）を $EDITOR で編集（queued のみ） |
| `[` `]` | キュー順を前へ／後ろへ（queued のみ） |
| `x` | queued は削除、実行中はキャンセル、Dropped はブランチ破棄（確認あり） |
| `u` | Dropped を Review に戻す |
| `A` | Done アーカイブの開閉 |
| `Enter` / `Esc` | 詳細表示 / 戻る |
| `g` | 詳細画面から、そのタスクの Herdr ペインへジャンプ |
| `?` / `q` | ヘルプ / 終了 |

以前は Queued / Running / Asking / Review / Failed の5レーンを持つ Board タブが
別にありましたが、うち3レーンが Tasks と重複し、同じキーが両タブで別の意味
（`J` = ジャンプ / 優先度下げ、`x` = ブランチ破棄 / キャンセル）を持っていたため、
1本のリストに統合しました。縦1列なので横幅の狭い端末（moshi 経由のモバイル等）
でも同じ表示のまま使えます。画面に入り切らない分は `… +N more` として明示されます
（Ink はスクロールできないため、行数は明示的に配分しています）。

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
(dispatcher, hooks, task commands), `packages/tui` (Ink: task list + config).

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
