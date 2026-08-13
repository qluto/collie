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

### 1日のサイクル

| | |
|---|---|
| **昼** | タスクを投函 — 3つの質問（repo・タイトル・サイズ）のあと `$EDITOR` でプロンプト。10秒。 |
| **夜** | スケジュール・あなたの不在・クォータ残量の3つが揃ったときだけ、ディスパッチャがキューから拾う。 |
| **朝** | 回収する — 承認、返答、再実行。 |

タスクの軸は2つで、決して同じ意味にはなりません:

- **`size`**（S/M/L）— トークン消費の見積もり。**ゲートとして効きます**:
  conservative なウィンドウは大きすぎるタスクを拾いません。
- **`priority`** — キューの並び順だけ。

### クォータは推定ではなく実測値

ゲートは Anthropic 自身が持つ消費率 — Claude Code の `/usage` パネルが見せている
数字そのもの — を最大10分に1回読み、ディスパッチャと TUI が1回の呼び出しを共有
します。`fraction_full` と `fraction_conservative` は**そのパーセンテージ**に対する
上限です。読めないときは ccusage のトークン推定に自動で落ちます。Claude の認証情報は
読むだけで、リフレッシュはしません。

**burn-down**（`[quota.burn_down]`、既定 on）: セッション予算は reset で消えて
しまうので、reset が近い full ウィンドウでは通常の上限ではなく `fraction`（0.95）
まで使えます。適用中は TUI のヘッダーに `⌛ burn-down` が出ます。

### presence — あなたがいる間は動かさない

既定 off。`[presence] enabled = true` にすると macOS の入力アイドル時間がゲート
信号になります。あなたがマシンの前にいる間、モードは `when_present`（既定
`paused`）で頭打ちになります。これは full ウィンドウだけでなく**すべてのウィンドウ**
に効きます。`absent_upgrade = true` なら長時間不在のマシンはウィンドウ外でも full に
昇格します（`paused` は決して昇格しません）。何も変えなかった上限も自己申告するので、
「on だが何も起きていない」状態を off と見分けられます。

### 隔離とレビュー

各タスクは自分専用の git worktree の中で、自分専用の `collie/<id>` ブランチ上で、
自分専用の Herdr ペインで走ります。人間が中身を見るまで `done` にはなりません:
終わったセッションは **review** に着地し、あなたが昇格させます。

**ブランチをマージすることがレビューです。** review のタスクのブランチが既に HEAD に
含まれていれば、自動で done に昇格します。したがって done に残っていてブランチが
**未マージ**のものは、あなたが見て捨てた仕事です。TUI はそれを `🗑 Dropped` として
見せ、ブランチを破棄するかタスクを再開するかを選べます。あとからそのブランチを
マージすれば、単に dropped でなくなります。

タスクの repo は**登録した時点で**検証されます — 存在すること、ディレクトリで
あること、git チェックアウトであること。キャプチャフォームは repo 欄から先に進めず、
`task add` は `$EDITOR` を開く前に止まります。

### 質問が夜を潰さない

質問で止まっているタスクは WIP 制限に数えられないので、1つの詰まったセッションが
キューを飢えさせることはありません。エージェントの質問は朝に備えてタスクに記録され、
`asking_limit` が、ディスパッチが止まるまでに積み上がってよい件数を決めます。

### Linear 連携（任意・既定 off）

マーカーラベルが付き、**かつあなたにアサインされた** issue がキュー済みタスクに
なります。ポーリングは `poll_interval_min`（既定5分）ごとです。1つのボードと1つの
ラベルをチーム全員で共有できるので、同じ issue を複数人のマシンが取り合わないように
するのがアサインの役割です。`assignee = "any"` で無効にできます。

ラベルは付いているがあなたのものでない issue は理由付きでスキップされます
（`assigned to Sam`、`unassigned — assign it to yourself…`）。誰もがやる
「ラベルを付けてアサインを忘れる」が、黙って消えるのではなく見えるようになります。

**どの repo の話かは**「具体的なものから」の順で決まります:

1. issue の repo ラベル — Linear の**ラベルグループ** `repo` の子、または
   フラットな `repo:myapp` ラベル
2. issue の**プロジェクト名**
3. **チームキー**

各段でまず `[linear.repos]` を引き、無ければ `[repos] roots` 配下のチェックアウトを
ディレクトリ名で照合します。Linear のプロジェクト名がチェックアウト名と同じなら
**設定は一行も要りません**。表は2つの名前が食い違うときのためだけのものです。
取り込み時にはどの段で決まったかを必ず出します（`via project myapp`）。

repo ラベルがどれにも当たらない場合、チームの repo に落とさずその issue を
スキップします。プロジェクトが未対応の場合は落ちるので、チームの欄は「それ以外は
全部ここ」を意味します。

見送られた issue は必ず理由を言い、`collie linear sync --dry-run` は何も書かずに
計画の全部を見せます:

```
would import  ENG-42  fix the flaky login test  -> ~/dev/projects/myapp  (via project myapp)
skip    ENG-43  state "In Progress" is already under way
skip    OPS-7   no repo named OPS (repo/… label, project, team) — add it to [linear.repos] or rename to match a checkout
1 would be imported, 2 skipped (dry run: nothing written)
```

**issue のステータスは「取り込み時」ではなく「実行開始時」に動きます** — 取り込んだ
タスクは一晩キューに座っていることもあるためです。ディスパッチャはセッションが
始まった瞬間に動かし、タスクIDとブランチ名をコメントします。Linear に届かなくても
セッションはそのまま走ります。同じ issue が二重に回収されることはなく、Linear の
優先度はキュー順に反映されます（Urgent が先頭）。

### パーミッションモード

既定は `auto` で、これは Claude Code 自身の既定でもあります: 低リスクなツール
呼び出しは実行され、残りはブロックされます。`bypassPermissions` は起動時に
ダイアログを出しますが**ディスパッチャはこれに答えません**。指定したタスクは
その前で固まります。

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
出ます — `● any size` / `● up to M` / `● paused`。Config タブは両方を並べて表示します
（`00:00-07:00 full — any size`）。

### 4. ディスパッチャを常駐させる

```sh
collie dispatcher install     # launchd エージェント。すぐ起動します
collie dispatcher status
tail -f ~/.collie/logs/dispatcher.log
```

新しいコードを読ませるには `collie dispatcher restart`。設定の変更に再起動は不要で、
次の tick で再読込されます。

### 5. 任意: Linear

API キーは macOS Keychain から読みます。`config.toml` には置きません:

```sh
security add-generic-password -s "collie-linear" -a "$USER" -w "lin_api_..."
```

```toml
[linear]
enabled = true
label = "collie"             # このラベルの付いた open な issue を回収
assignee = "me"              # me|any — "me" が同一チーム内の取り合いを防ぐ
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

セクションごと書かないことも完全な設定です。その場合 collie は Linear へ一切通信せず、
Keychain も読みません。

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

`type = "shell"` は detached 実行なので、結果は Herdr の通知で返り
（`[ui.toast] delivery = "off"` だと何も出ません）、ペイン名が `✓ <task id>` に
変わります。

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

色が合図です: 色の付いたグループはあなたを待っており、色の無いグループは待って
いません。グループ固有のキーはそのグループのヘッダーに乗り、フッターは全体共通の
キーだけです。ヘッダー2行目は常に予算予報です
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

リストは端末に合わせて自身を収め、表示できなかった分を必ず言うので（`… +N more`）、
幅の狭い画面でもそのまま使えます。

`a` に関する注意が1つ: これはリテラルなテキストを送ります。エージェントが選択メニュー
で尋ねてきた場合は、代わりにペインへジャンプ（`J`）してください。

### タスクを終わらせる

review のタスクを昇格させるのはあなたです。TUI の `d` のほかに、**エージェント自身の
ペインに居たまま**終わらせられます:

```sh
!collie done          # Claude の入力欄で。! はシェルコマンドを実行する
```

`$COLLIE_TASK_ID` またはフォーカス中の Herdr ペインからタスクを逆引きするので id は
不要で、冪等です。

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
マージ済みのブランチだけ**を削除します。追跡下の変更があれば `--force` 込みでも
中止し、未追跡ファイルだけなら `--force` で消えます。

```
✓ t-20260809-6b40  worktree removed; deleted merged branch collie/t-MERGED
· t-20260809-eeaa  worktree removed; kept collie/t-AHEAD: not merged (1 commit(s) ahead of HEAD)
1/2 cleaned
```

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
bun test
bunx tsc --noEmit
```

コントリビュータ向けのメモ — ワイヤの癖、不変条件、テストの流儀 — は
[CLAUDE.md](CLAUDE.md) にあります。

モノレポ（bun workspaces）: `packages/core`（ストア、Herdr クライアント、クォータ、
Linear）、`packages/cli`（ディスパッチャ、フック、task コマンド）、`packages/tui`
（Ink: タスク一覧 + config）。

実行時データは `~/.collie/` にあり、`COLLIE_HOME` で差し替えられます — 既定の
ディレクトリに対して本物のディスパッチャが走っているので、実験には一時ディレクトリを
指してください。

## 制限事項

- キャンセルはペインを殺しません（Herdr 側で閉じてください）。
- 週次クォータは 7 日のローリング合計として推定しており、Anthropic 実際の週次
  リセット境界ではありません。
- 1マシンにつきディスパッチャは1つ。タスクの依存関係や DAG はなく、worktree からの
  自動 PR もありません。`collie gc` が削除するのは HEAD にマージ済みのブランチだけで、
  マージ自体はあなたに委ねられています。
- タスク完了時に Linear へ書き戻しは行いません。issue は started 状態のまま残るので、
  あなたが閉じてください。

## ライセンス

MIT — [LICENSE](LICENSE) を参照してください。
