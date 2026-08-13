# collie 🐑🐑🐕

Claude Code セッションのための**無人作業箱**。[Herdr](https://herdr.dev) —
羊飼いの牧羊犬 — の上で動きます。

昼のうちにコーディングタスクを投げ込んでおく。夜、あなたがキーボードの前にいない
間に、ディスパッチャが余ったトークン枠をそれらに費やす。朝、結果を回収する —
できたものを承認し、エージェントが詰まった質問に答え、失敗を再実行する。

*[English README](README.md)*

---

## 機能

collie にタスクを入れるということは、**「これは私がいなくても走る」という宣言**です。
以下すべてがこの1つの考えから来ています。

### 1日のサイクル

| | |
|---|---|
| **昼** | タスクを投函 — 3つの質問（repo・タイトル・サイズ）のあと `$EDITOR` でプロンプト。10秒。 |
| **夜** | スケジュール・あなたの不在・クォータ残量の3つが揃ったときだけ、ディスパッチャがキューから拾う。 |
| **朝** | 回収する — 承認、返答、再実行。 |

タスクの軸はちょうど2つで、決して同じ意味にはなりません:

- **`size`**（S/M/L）— トークン消費の見積もり。**ゲートとして効きます**:
  conservative なウィンドウは大きすぎるタスクを拾いません。
- **`priority`** — キューの並び順だけ。ゲートの力は一切ありません。

### クォータは推定ではなく実測値

ゲートは Anthropic 自身が持つ消費率 — Claude Code の `/usage` パネルが見せている
数字そのもの — を `GET /api/oauth/usage` から読みます。取得は最大10分に1回で、
`$COLLIE_HOME/limits.json` にキャッシュしてディスパッチャと TUI が1回の呼び出しを
共有します。`fraction_full` と `fraction_conservative` は**そのパーセンテージ**に
対する上限です。

未公開エンドポイントなので best-effort 扱いです。読めないときは ccusage の
トークン推定（`block_budget_tokens` ほか）に自動で落ちます。認証は macOS Keychain
にある Claude の OAuth トークンで、collie は**読むだけ**です — 期限切れは
「取得不可」であって「再認証せよ」ではありません。リフレッシュはあなたの認証情報を
ローテーションさせてしまうからです。

**burn-down**。セッション予算は reset で消えてしまうので、`[quota.burn_down]`
（既定 on）は full ウィンドウが reset まで `window_min` 分を切ったところで上限を
`fraction`（0.95）まで緩めます。使わなかった余力はどのみち失われるので。適用中は
ヘッダーに `⌛ burn-down` が出ます。

### presence — あなたがいる間は動かさない

既定 off。`[presence] enabled = true` にすると macOS の入力アイドル時間がゲート
信号になります。人がマシンの前にいる間、モードは `when_present`（既定 `paused`）で
頭打ちになります。

この上限は full だけでなく**すべてのウィンドウ**に効きます。full だけを降格して
いた頃は、日中の conservative なウィンドウで presence が何もせず — まさに respect
すべき人間がそこにいる時間帯に — 目の前で作業中のユーザーにタスクが投入されて
いました。`absent_upgrade = true` なら長時間不在のマシンはウィンドウ外でも full に
昇格します（`paused` は決して昇格しません）。上限が効かなかった場合も
`presence: human at keyboard (already conservative)` と自己申告するので、「on なのに
何もしていない」状態を off と見分けられます。

### 隔離とレビュー

各タスクは自分専用の git worktree の中で、自分専用の `collie/<id>` ブランチ上で、
自分専用の Herdr ペインで走ります。人間が中身を見るまで `done` にはなりません:
終わったセッションは **review** に着地し、あなたが昇格させます。

**ブランチをマージすること自体がレビューです。** review のタスクのブランチが既に
HEAD に含まれていれば、自動で done に昇格します。したがって done に残っていて
ブランチが**未マージ**のものは、あなたが見て捨てた仕事です — TUI はそれを
`🗑 Dropped` として見せ、ブランチを破棄するかタスクを再開するかを選べます。この
ために何かをタスクに記録することはしません。毎回 git から導出するので、1週間後に
そのブランチをマージすれば単に dropped でなくなります。

**タスクの repo は登録時に検証されます** — 実行時ではなく。存在すること、
ディレクトリであること、git チェックアウトであること。キャプチャフォームは repo 欄
から先に進めず、`task add` は `$EDITOR` を開く前に止まります。そうしない場合の
代償は、深夜2時に `worktree.create` が失敗し、attempts を使い切り、翌朝それを
知ることです。

### 質問が夜を潰さない

質問で止まっているタスクは WIP 制限に数えられません — トークンを消費しないので —
1つの詰まったセッションがキューを飢えさせることはありません。フックのメッセージと
ペインのスクレイプがタスクに載り、朝に備えます。`asking_limit` が、その山が
際限なく積み上がるのを止めます。

### Linear 連携（任意・既定 off）

マーカーラベルの付いた issue がキュー済みタスクになります。他社の API なので、
30秒の dispatch tick ではなく分単位（`poll_interval_min`、既定5分）でポーリング
します。

**どの repo の話かは対応表ではなく「具体的なものから」の連鎖で決まります** — 1つの
Linear workspace はもちろん、1つの *team* ですら repo 1つとは限らないためです:

1. issue の repo ラベル — Linear の**ラベルグループ** `repo` の子
   （API は `name="myapp", parent="repo"` と返します。子の名前にグループ名は
   入りません）、またはフラットな `repo:myapp` ラベル
2. issue の**プロジェクト名** — 1チーム内での通常の軸
3. **チームキー** — 「それ以外は全部ここ」

各段でまず `[linear.repos]` を引き、無ければ `[repos] roots` 配下のチェックアウトを
**ディレクトリ名で照合**します。つまり Linear のプロジェクト名がチェックアウト名と
同じなら**設定は一行も要りません**。表は2つの名前が食い違うときのためだけのものです。
取り込み時にはどの段で決まったかを必ず出します（`via project myapp`）。

意図的な非対称が2つあります: repo ラベルが解決できないときは**連鎖を止めます**
（repo を名指しした指示なので、無視すれば「うまくいったように見えて別の repo に
仕事を送る」ことになります）。一方、未対応のプロジェクトはチーム既定に落ちます
（プロジェクトはボードの整理軸にすぎないため）。

**見送られた issue は必ず理由を言います。** collie 用のラベルを付けたのに何も
起きない、が一晩を無駄にする類の失敗なので、`collie linear sync --dry-run` は
何も書かずに計画の全部を出します:

```
would import  ENG-42  fix the flaky login test  -> ~/dev/projects/myapp  (via project myapp)
skip    ENG-43  state "In Progress" is already under way
skip    OPS-7   no repo named OPS (repo/… label, project, team) — add it to [linear.repos] or rename to match a checkout
1 would be imported, 2 skipped (dry run: nothing written)
```

**Linear のステータスは「取り込み時」ではなく「実行開始時」に動きます。** 取り込みは
issue がキューに届いたというだけで、presence・WIP・クォータ次第では一晩そこに
座っていることもあります。その間 In Progress になっているのは盤面の嘘です。
ディスパッチャはタスクが running に遷移した直後に動かします — その時点で取り込み時の
スナップショットは数時間古いので、issue を読み直した上で — そしてタスクIDと
ブランチ名をコメントします。すべて best-effort で、失敗は走り続けているセッションに
対する警告どまりです。

二重回収は2重に防いでいます: ローカルの台帳（`linear.json`）と、Linear 側の状態
そのもの（実行されたタスクの issue は started になっており、started は回収対象外）。
Linear の優先度はキュー順に反映されます（Urgent が先頭、未設定は Normal 扱い）。

### パーミッションモード

既定は `auto` で、これは Claude Code 自身の既定でもあります: 分類器が低リスクと
判断したツール呼び出しだけを実行し、残りをブロックする — 無人作業に合った挙動です。
`bypassPermissions` は起動時に確認ダイアログを出しますが、**ディスパッチャはこれを
自動確認しません**（フォルダ信頼ダイアログと違い、こちらは意図的なゲートなので）。
これを指定したタスクはダイアログの前で固まります。

### 仕組み

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

痛い目を見て決めた設計:

- **完了は明示的な CLI コールバック** — Herdr の `done` ステータス（人がタブを見ると
  消える）でも、Stop フック（応答のたびに発火する）でもありません。忘れられた
  コールバックは `idle_grace_min` 後にウォッチドッグが review へ回すので、何も
  黙って固まりません。
- **プロンプト投入は1行のポインタ**（`runs/<id>/prompt.md` を指す）。Claude の
  入力欄への複数行ペーストは罠です。
- **起動時ダイアログ**: フォルダ信頼ダイアログは `blocked`/`unknown` と読めるため、
  ディスパッチャが自動確認します — repo にタスクを積んだこと自体が信頼の判断なので。
  準備完了の判定は `agent.get` の `interactive_ready` であって、画面スクレイプの
  ステータスではありません。
- **ソケットは多重化しない**: Herdr のエラーフレームはリクエスト id を失うことが
  あるため、クライアントは1リクエスト1接続、加えて実行中ペインごとに購読専用の
  接続を1本持ちます。
- **サイドバー表示は `pane.report_metadata` のみ** — 意味的なエージェント状態を
  報告すると、ディスパッチャ自身が読む `agent_status` にフィードバックしてしまいます。
- **限界ヒット**はペインからスクレイプします（`You've hit your session limit ·
  resets 3:45pm`）。Claude 自身が印字した reset 時刻がそのままディスパッチの
  ハード停止（+ジッター）になり、タスクは attempts を**消費せずに**再キューされます。

---

## セットアップ

### 前提

- macOS（presence は IOKit の HID アイドルタイマーを使い、ディスパッチャは launchd
  エージェントです）
- [Herdr](https://herdr.dev) が動作していること（ソケットは
  `~/.config/herdr/herdr.sock`）
- [Bun](https://bun.sh)
- `PATH` の通った Claude Code

### 1. インストール

```sh
bun install

# `collie` シムを PATH に置く（または `bun link`）
printf '#!/bin/sh\nexec %s %s "$@"\n' "$(which bun)" "$PWD/packages/cli/src/index.ts" \
  > ~/.local/bin/collie && chmod +x ~/.local/bin/collie
```

### 2. 環境チェック

```sh
collie doctor
```

データディレクトリ、設定ファイル、Herdr ソケット、presence プローブ、Claude Code、
ccusage、usage API を検証します。

### 3. 設定

`~/.collie/config.toml` は初回起動時にコメント付きの既定値で作られます。最初に
見るべき設定:

```toml
[[schedule.windows]]
start = "00:00"
end = "07:00"
mode = "full"        # すべてのウィンドウ外: conservative

[repos]
# 2階層まで探索するので、フラットな配置でも ghq のホストルートでも動きます
roots = ["~/dev/projects", "~/ghq/github.com"]

[presence]
enabled = true       # あなたがキーボードの前にいる間は新規に始めない
```

`[repos] roots` は新規タスクの repo ピッカー（入力でフィルタ、↑↓ で選択、自由入力も
可）と、Linear 取り込みの名前照合に使われます。

モード名は設定ファイルの語彙です。TUI のヘッダーには各モードが実際に**何を拾うか**が
出ます — `● any size` / `● up to M` / `● paused`。Config タブは両方を並べて見せる
唯一の場所です（`00:00-07:00 full — any size`）。

### 4. ディスパッチャを常駐させる

```sh
collie dispatcher install     # launchd エージェント。すぐ起動します
collie dispatcher status
tail -f ~/.collie/logs/dispatcher.log
```

新しいコードを読ませるには `collie dispatcher restart`。設定の変更に再起動は不要で、
次の tick で再読込されます。

### 5. 任意: Linear

API キーは macOS Keychain から読みます。`config.toml` には決して置きません
（Config タブがそのファイルを全文表示するため）:

```sh
security add-generic-password -s "collie-linear" -a "$USER" -w "lin_api_..."
```

```toml
[linear]
enabled = true
label = "collie"             # このラベルの付いた open な issue を回収
poll_interval_min = 5
size = "M"                   # 取り込んだタスクに付けるサイズ
start_state = ""             # "" = そのチームの最初の started 状態
comment = true               # collie のタスクIDを issue にコメント
repo_label_group = "repo"    # 子ラベルが repo 名になる Linear のラベルグループ
repo_label_prefix = "repo:"  # グループを使わないワークスペース向けの書き方

[linear.repos]
# Linear 側の名前とチェックアウトのディレクトリ名が食い違うときだけ必要
"Mobile app" = "~/dev/projects/myapp"
"ENG"        = "~/dev/projects/monorepo"   # 「それ以外」の既定
```

そのあと、何も書き込まずに確認できます:

```sh
collie linear status
collie linear sync --dry-run
```

セクションごと書かないことも完全な設定です。その場合 collie は Linear へ一切
通信せず、Keychain を読むことすらしません。

### 6. 任意: Herdr のキーバインド

投函ポップアップと1キーの done。どちらも TUI に戻る手間をなくします:

```toml
# ~/.config/herdr/config.toml
[[keys.command]]
key = "prefix+t"
type = "popup"                          # 呼び出したペインの cwd を引き継ぐ
command = "~/.local/bin/collie new --popup"

[[keys.command]]
key = "prefix+d"
type = "shell"
command = "~/.local/bin/collie done"    # 絶対パスで書くこと
```

`type = "shell"` は detached 実行なので標準出力が誰にも届きません。結果は Herdr の
通知で返り（`[ui.toast] delivery = "off"` だと何も出ません）、設定に依存しない
確実な合図としてペイン名が `✓ <task id>` に変わります。

---

## 操作

### TUI

```sh
collie tui
```

vim や htop と同じ全画面（オルタネートスクリーン）で動き、終了時にシェル画面を
復元します。IME 対応: 変換中テキストは入力欄のカーソル位置にインライン表示され、
複数文字の一括確定でも文字が欠けません。

タブは **Tasks** と **Config** の2枚。Tasks はすべてのタスクを1本の縦リストに
まとめた画面で、人が処理する順に並びます — 決断を待つ3グループ、次に何も要求しない
2グループ、最後に片付いたもの:

```
✅ Review  2                                    ← カードごとに diff 要約
❓ Asking  1                                    ← エージェントの質問をインライン表示
❌ Failed  1
🏃 Running  1 · J jump · x cancel               ← ハートビート付き
⏳ Queued  3 · e edit · [ ] reorder · x delete  ← 優先度・サイズ・repo
🗑 Dropped  1 · x discard · u reopen
📦 Done  42 · A to open
```

色がすべての合図です: 色の付いたグループはあなたを待っており、色の無いグループは
待っていません。グループ固有のキーはそのグループのヘッダーに乗り、フッターは全体
共通のキーだけです。ヘッダー2行目は常に予算予報です
（`session 42% · resets 02:00 (+3h10m) · headroom 43% ≈5 tasks`）。

| キー | 動作 |
|---|---|
| `1` `2` | Tasks / Config タブ |
| `j k` / 矢印 | カーソル移動 |
| `n` | 新規タスク（repo → タイトル → サイズ、そのあと `$EDITOR` でプロンプト） |
| `d` | review → done へ昇格（done はアーカイブへ移動） |
| `a` | asking のタスクに返答（そのペインに入力され、セッションが再開する） |
| `r` | retry（review / failed。attempts をリセット） |
| `J` | そのタスクの Herdr ペインへジャンプ |
| `o` | そのタスクの Claude セッションを再開（`claude --resume`） |
| `e` | プロンプト（または config）を `$EDITOR` で編集（queued のみ） |
| `[` `]` | queued のタスクをキューの前へ／後ろへ |
| `x` | queued は削除、実行中はキャンセル、dropped はブランチ破棄（確認あり） |
| `u` | dropped のタスクを再開 |
| `A` | done アーカイブの開閉 |
| `Enter` / `Esc` | 詳細 / 戻る |
| `g` | 詳細画面から、そのタスクの Herdr ペインへジャンプ |
| `?` / `q` | ヘルプ / 終了 |

Ink はスクロールできないため、最終行より先にあるものは単に消えます。リストは行数を
明示的に配分し、落としたものを必ず言います（`… +N more`）。1本の縦列なので、幅の
狭い端末でもそのまま使えます。

`a` に関する注意が1つ: これはリテラルなテキストを送ります。エージェントが選択メニュー
で尋ねてきた場合は、代わりにペインへジャンプ（`J`）してください。

### タスクを終わらせる

review のタスクを昇格させるのはあなたです。TUI の `d` のほかに、**エージェント自身の
ペインに居たまま**終わらせられます:

```sh
!collie done          # Claude の入力欄で。! はシェルコマンドを実行する
```

`$COLLIE_TASK_ID` またはフォーカス中の Herdr ペインからタスクを逆引きするので、id は
不要です。冪等（既に done なら何も起きない）で、まだ running のタスクは review を
経由して done になります — ペインを見ている人間のほうが、完了コールバックより多くを
知っているからです。

`collie done --close` は後片付けまでやります:

| | 動作 |
|---|---|
| worktree タスク | `worktree.remove` — チェックアウト削除、ペインとワークスペースをクローズ、**ブランチは温存** |
| worktree なしのタスク | ペインを閉じるだけ |
| 未コミットの変更あり | 何もせず、件数を報告 |

`[done] close = true` でこれを既定にできます。

### 後片付け

```sh
collie gc [--dry-run] [--force]
```

done / failed のタスクについて、クリーンな worktree チェックアウトを外し、**HEAD に
マージ済みのブランチだけ**を削除します（`git branch -d` なので、未マージの仕事は
git 自身が拒否します）。追跡下の変更があれば `--force` 込みでも中止し、未追跡ファイル
だけなら `--force` で消えます。

```
✓ t-20260809-6b40  worktree removed; deleted merged branch collie/t-MERGED
· t-20260809-eeaa  worktree removed; kept collie/t-AHEAD: not merged (1 commit(s) ahead of HEAD)
1/2 cleaned
```

タスクは回収できるものが残っている間だけ報告されます — 人間が既に削除したブランチは、
永久に出続けるのではなく出力から消えます。

### CLI リファレンス

```
collie task add --repo <path> --title <t> [--size S|M|L] [--priority N]
                [--no-worktree] [--permission-mode <m>] [--prompt <text>]
collie task list [--status s1,s2] [--json]
collie task show <id>
collie task queue|retry|cancel|done <id>
collie task complete <id> --summary "<text>"
collie task fail <id> --reason "<text>" [--retryable]

collie done [<id>] [--close]     # どこからでも review -> done
collie gc [--dry-run] [--force]

collie dispatcher run [--once] [--verbose] | status
collie dispatcher install | restart | uninstall      (launchd)

collie linear sync [--dry-run] | status

collie new [--popup]             # 投函フォーム単体。popup バインド用
collie tui
collie doctor
collie hook <name>               # 内部用: 生成された Claude フックから呼ばれる
```

---

## 開発

```sh
bun test           # 253 tests: ストアのロック + アーカイブ、herdr クライアント
                   # （偽ソケット）、burn-down 込みのクォータゲート、presence、
                   # forecast、スケジュールウィンドウ、reset パーサ、repo 探索、
                   # git ヘルパ、Linear の plan + sync（偽 API）、TUI 描画
bunx tsc --noEmit  # strict
```

コントリビュータ向けのメモ — ワイヤの癖、不変条件、テストの流儀 — は
[CLAUDE.md](CLAUDE.md) にあります。

モノレポ（bun workspaces）: `packages/core`（ストア、Herdr クライアント、クォータ、
Linear）、`packages/cli`（ディスパッチャ、フック、task コマンド）、`packages/tui`
（Ink: タスク一覧 + config）。

実行時データは `~/.collie/` にあり、`COLLIE_HOME` で差し替えられます — 既定の
ディレクトリに対して本物のディスパッチャが走っているので、実験には必ず一時
ディレクトリを指してください。`COLLIE_DEBUG=1` は生のソケットフレームをログに出し、
`COLLIE_CCUSAGE_BIN` と `COLLIE_LINEAR_API_URL` は使用量推定器と Linear クライアントを
偽物に向けます。

## 制限事項

- キャンセルはペインを殺しません（検死しやすさ優先。Herdr 側で閉じてください）。
- 週次クォータは 7 日のローリング合計として推定しており、Anthropic 実際の週次
  リセット境界ではありません。
- 1マシンにつきディスパッチャは1つ。タスクの依存関係や DAG はなく、worktree からの
  自動 PR もありません。`collie gc` が削除するのは HEAD にマージ済みのブランチだけで、
  マージ自体は人間に委ねられています。
- タスク完了時に Linear へ書き戻しは行いません。issue は started 状態のまま残るので、
  人間が閉じてください。
