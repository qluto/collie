# collie build plan

Plan: /Users/qluto/.claude/plans/expressive-bubbling-avalanche.md
Design doc: /Users/qluto/.claude/plans/expressive-bubbling-avalanche-agent-ahub-plan-0de8102b23c5fcfe.md

## Phase 0 — Scaffold + store + task CLI
- [x] Monorepo scaffold (workspaces, tsconfig, gitignore)
- [x] core: types, paths, config, lock, store, journal
- [x] cli: task add/list/show/queue/backlog/retry/cancel/complete/fail, doctor (partial)
- [x] Tests: store unit + illegal transitions + 2-process concurrency (rev=400) — 13 pass
- [x] bun link → `collie` bin

## Phase 1 — MVP end-to-end loop
- [x] herdr client (request one-shot, subscribe long-lived) + fake-socket tests (6 pass)
- [x] dispatcher loop (WIP gate only), dispatch sequence, reconcile, idle watchdog
- [x] hooks: session-start / stop / notification / session-end
- [x] E2E: HELLO.md task queued→running→blocked→review, commit landed; completion
      arrived while dispatcher was dead (hook-only path); kill-pane → SessionEnd
      requeue → unattended re-run to review
- Field findings: folder-trust dialog auto-confirm needed; agent.start name must
  be unique (task id used); pane.read wire format is recent_unwrapped; boot
  spinner briefly reads as "working" (ready check uses live agent.get, idle only)

## Phase 2 — Quota + schedule + limits + launchd
- [x] ccusage wrapper (cache, env override), gate math, schedule windows
- [x] limit-string scraper → blockedUntil (+learned ceiling, attempt-free requeue)
- [x] dispatcher install/uninstall (launchd) — installed, KeepAlive verified
- [x] Unit tests: gate, windows (midnight-crossing), reset parser — 40 total
- Field findings: SIGTERM must interrupt inter-tick sleep + exit non-zero for
  KeepAlive restart; same-ms task creation needed a stable sort tie-breaker

## Phase 3 — Ink TUI
- [x] board / detail / new-task / dashboard / config views
- [x] $EDITOR suspend/resume, fs.watch + poll refresh
- [x] ink-testing-library tests; bun raw-mode verified live in a Herdr pane
      (node fallback not needed)

## Phase 4 — Worktrees + polish
- [x] worktree.create + reuse-on-retry (worktree.open → agents-scan fallback);
      verified E2E: task ran on its own branch, main untouched
- [x] Notification hook blocked flow (+ herdr notification), post-tool-use
      throttled heartbeat
- [x] Sidebar integration via pane.report_metadata ONLY (report_agent would
      feed back into our own status reads)
- [x] README (JA quickstart + EN docs)

## Review

All four phases landed and E2E-verified against live Herdr + real claude
sessions. Real-environment lessons that changed the design:
1. claude's folder-trust dialog reads as blocked/unknown → auto-confirm during
   ready-wait; readiness requires a live `idle` from agent.get (boot spinner
   briefly reads as "working" via cached events).
2. agent.start names are unique per server → task id doubles as the name.
3. Requeue must clear run.paneId or the candidate filter (adoption guard)
   starves the task forever.
4. SIGTERM must interrupt the tick sleep AND exit non-zero, or launchd
   KeepAlive won't restart after an accidental kill.
5. Wire enums are snake_case (recent_unwrapped); pane.run doesn't exist on the
   wire; pane.read wraps hard → whitespace-normalized echo verification.
Deliberate deviation from the design doc: sidebar reporting uses
report_metadata only (see Phase 4 note); completion callback is pre-allowed in
generated settings.json permissions so it never blocks at 3am.

The launchd dispatcher (com.qluto.collie.dispatcher) is installed and
running against the real ~/.collie with the default config (00:00–07:00
full throttle). Queue is empty until real tasks are added.

## Phase 5 — `defer` flag (urgency as its own axis)

Problem: `size` (a token-cost estimate) was doubling as the "run this at night"
signal, and `priority` is a pure sort key with no gating power. Tasks that are
unattended-safe but not urgent had no way to say so.

Design: per-task boolean `defer` = "only dispatch in a `full` schedule window".
Three orthogonal axes — size = cost, priority = order, defer = eligibility.

- [x] core/types: `Task.defer: boolean`, `NewTaskInput.defer?: boolean`
- [x] core/store: FRONTMATTER_KEYS, parse fallback (`?? false`) for existing
      task files, createTask default
- [x] core/quota/gate: pure `modeAdmits(task, mode, cap)` next to sizeFits
- [x] cli/dispatcher/gates: use modeAdmits; decision string breaks the skip
      reason down (deferred vs over size cap)
- [x] cli task add: `--defer`; list line shows a marker
- [x] tui: new-task form step, board badge, detail row, `D` toggle + keymap
- [x] tests: gate admission matrix, store round-trip + legacy-file default
- [x] docs: README + CLAUDE.md

### Review

`modeAdmits` lives in core next to `sizeFits`/`quotaAllows` so the admission
policy is one pure, tested function instead of an inline predicate in the
dispatcher. Verified against a temp COLLIE_HOME + fake ccusage:

    conservative                | dispatching t-…f2b4 (S, not deferred)
    full                        | dispatching t-…5c4e (the p1 deferred one)
    deferred-only, conservative | no candidate fits conservative mode
                                  (1 deferred) — waiting for a full window
    deferred-only, full         | dispatching t-…5c4e

The new-task form was driven end-to-end through ink-testing-library: 7 steps in
order, `defer: true` in the submitted draft, repo/title cursor anchors still at
screen rows 4/5 (the defer row sits below them, so the fixed geometry holds).

Incidental fix: `tsconfig.json` only included `test/**/*.ts`, so `.tsx` tests
were never typechecked — board.test.tsx's Task fixture would have silently
missed the new required field. Now included.

## Phase 6 — permission modes tracked to the claude CLI

A task spawned with `bypassPermissions` wedged on claude's startup confirmation
dialog (the dispatcher only auto-confirms folder-trust) and then failed.

- [x] `PermissionMode` now mirrors `claude --permission-mode` (2.1.226):
      auto / acceptEdits / plan / manual / dontAsk / bypassPermissions, with
      `default` kept as a legacy alias (verified: the CLI still accepts it even
      though it dropped out of the advertised choices when it became `manual`)
- [x] `auto` is the new default (config template, DEFAULT_CONFIG, TUI form
      ordering) — per claude's own strings: "Auto mode lets Claude handle
      permission prompts automatically … runs the ones it assesses as
      lower-risk, and blocks the rest"
- [x] `PERMISSION_MODES` exported from core; `task add --permission-mode` is
      validated instead of blindly cast
- [x] Fixed: any post-spawn dispatch failure left the herdr agent alive while
      `requeueOrFail` cleared run.paneId, so the retry hit `agent_name_taken`
      and the task always burned both attempts. spawn_timeout / inject_failed
      now `pane.close` first (these panes never got a prompt — nothing to
      inspect, unlike a cancelled task's live pane).
- [x] `retryTask` in core resets attempts to 0 (CLI `task retry` + TUI `r`).
      A retry with no attempt budget fails again on the first hiccup.

### Review

Recovered t-20260808-5a56 live: closed the orphan agent (w28:p2), moved it to
`auto`, cleared the stale pane identity, `task retry` → dispatched into w29:p2
and running 5s later, footer showing "⏵⏵ auto mode" and the session already
reading the file named in the prompt. No dialog wedge.

Also observed during the switch: the old dispatcher rejected the new
config.toml for six ticks ("permission_mode must be one of default|plan|
acceptEdits|bypassPermissions") and kept running on its previous config —
the per-tick config reload's validation working exactly as intended, but a
reminder that config changes need `collie dispatcher restart` to take effect
when they use newly-added values.

## Phase 7 — readable board + jump to pane

- [x] `truncateToWidth` / `wrapToWidth` in cursor.ts (next to displayWidth).
      Ink's own `wrap="truncate"` miscounts CJK by one cell and pushed the
      column's right border off the row — visible as broken boxes whenever a
      Japanese title was truncated.
- [x] Explicit column widths instead of flexGrow, so yoga can't round
      differently than the width arithmetic the truncation used.
- [x] Accordion: the focused column takes FOCUS_SHARE of the row (capped at
      MAX_FOCUS so a wide terminal feeds the other columns instead). Six equal
      columns leave ~14 cells each — no Japanese title survives that.
- [x] Card layout: title owns line 1 (wrapping to 2 lines when the column is
      wide), metadata moved to a dim line 2 that narrow columns drop entirely.
- [x] Column header keeps the count and truncates the name, never the number.
- [x] `g` in the detail overlay jumps to the task's Herdr pane
      (`agent.focus {target}`; there is no pane.focus on 0.7.1).
- [x] Tests: all frame rows must share one display width (the border-integrity
      invariant), focused column shows a full Japanese title.

### Review

Live-verified in a scratch Herdr workspace at 195 columns: every card row
measured exactly 195 cells (one distinct width across the frame), the accordion
followed h/l, and `g` moved Herdr's focus from w26 to w29 (the task's
workspace). Scratch workspace closed and the user's focus restored afterwards.

## Phase 8 — one pane per task

`agent.start` always splits off a NEW pane; it has no "run in this pane"
argument (0.7.1 silently ignores unknown fields — verified by probing with
`pane_id`/`target`, both of which spawned an extra agent anyway). So every
dispatch left the workspace's own shell pane sitting next to the agent.

- [x] `resolveWorkspace` / `ensureWorktree` return the root pane id of a
      workspace THEY created; dispatch closes it right after agent.start.
- [x] Not done on the `worktree.open` retry path: reopening can hand back a
      workspace that was already open, whose root pane may be a human's.

### Review

Wire behaviour checked in a scratch workspace first (create → agent.start →
pane.close(root): 2 panes → 1, agent survives), then a real E2E dispatch in a
sandbox repo with an isolated COLLIE_HOME and a fake ccusage:

    task t-20260809-d514: worktree … (workspace w2E)
    confirming folder-trust dialog in w2E:p2
    task t-20260809-d514 running in pane w2E:p2
    pane.list w2E -> w2E:p2 agent=claude label=t-20260809-d514   (one pane)

Sandbox workspace, worktree and COLLIE_HOME removed afterwards.

## Phase 9 — `collie done` from the agent's pane

Goal: review the work where it happened and close the loop there, instead of
walking back to the board.

- [x] `markDone` in core: review → done; running/blocked route through review
      (the human at the pane knows more than the callback that never came);
      idempotent, because a keybinding will get pressed twice.
- [x] `collie done [<id>]` resolves the task by, in order: argument →
      `COLLIE_TASK_ID` → the task owning `HERDR_ACTIVE_PANE_ID` /
      `HERDR_PANE_ID`. Live tasks are matched before terminal ones (pane ids
      get reused, and a finished task keeps its paneId).
- [x] Every outcome also fires `notification.show`: the herdr keybinding runs
      the command DETACHED, so stdout reaches nobody.
- [x] Keybinding `prefix+d` added to ~/.config/herdr/config.toml, reloaded
      (`status: applied`, no diagnostics).

### link_click investigation (rejected)

`[[link_handlers]]` parse and register fine, but clicking a link in a pane
never invokes them: the probe plugin logged 0 hits and macOS reported "no
application set to open the URL collie://…", i.e. herdr handed the URL to the
OS. Plain custom-scheme text isn't even clickable — what works is Ghostty's own
http(s) link handling under cmd+shift, which is heavier than a keypress anyway.

### Review

Verified against an isolated COLLIE_HOME:

    no context at all           -> "no task id (pass one, or run this from …)"
    HERDR_ACTIVE_PANE_ID=w99:p2 -> t-…1f5b -> done          (keybinding path)
    same again                  -> t-…1f5b -> done          (idempotent)
    COLLIE_TASK_ID + stale pane -> resolves by task id      (!collie done path)
    queued task                 -> refused, "is queued; only a running or …"
    unknown pane                -> refused, "no collie task owns pane w77:p1"

Still unverified: the actual keypress. herdr's UI consumes real key events, so
the API can't simulate one — needs a human to press prefix+d once.

### Phase 9 follow-up — the toast was never arriving

`notification.show` answered `{shown:false, reason:"disabled"}`: herdr's
`[ui.toast] delivery` defaults to "off", so every collie notification since the
project started (including dispatcher limit hits) had been silently dropped.
Set `delivery = "herdr"` in ~/.config/herdr/config.toml, reloaded, verified
`{shown:true, reason:"shown"}`.

reason enum: shown | disabled | rate_limited | no_foreground_client | busy.
"busy" simply means another toast still owns the slot — a second notification
fired back-to-back is dropped, so a toast can never be the only feedback path.

- [x] `collie done` renames the pane to `✓ <task id>` — persistent, visible in
      the sidebar, independent of any user setting. Safe: pane.rename writes
      `label`, while `agent.list`'s `name` (agent.start's uniqueness key) is a
      separate field (verified on a scratch agent).
- [x] `notify()` returns herdr's `shown` flag; when it is false the CLI prints
      the reason hint (useful on the `!collie done` path where stdout is seen).

## Phase 10 — end of life: worktrees, panes, branches

Verified on a live worktree before designing anything: `worktree.remove`
takes a **workspace_id** (not a path), deletes the checkout, closes the pane
AND the workspace, refuses a dirty checkout (`dirty_worktree_requires_force`),
and leaves the branch with its commits intact. So teardown must NOT close the
pane first — the workspace has to still exist — and it can never lose accepted
work, because the work lives on the branch, not in the checkout.

- [x] `collie done --close` — worktree tasks go through worktree.remove,
      others get pane.close, a dirty worktree is reported and left alone.
- [x] `[done] close` config (default false, so the plain keypress stays
      non-destructive). `--close` overrides it per invocation.
- [x] `collie gc [--dry-run]` — for done/failed worktree tasks: drop the clean
      checkout, then delete the branch ONLY if HEAD already contains it.
      `git branch -d` is the real safety net; merging stays the human's call.
- [x] `core/src/git.ts` + tests against real temp repos (67 tests total).

Gotcha worth keeping: `git branch --merged --format=…` fails with "malformed
object name" — `--merged` swallows the next token as its optional commit
argument. `--format` must come first.

### Review

    gc --dry-run  ✓ would delete merged branch collie/t-MERGED
                  · kept collie/t-AHEAD: not merged (1 commit(s) ahead of HEAD)
    gc            ✓ worktree removed; deleted merged branch collie/t-MERGED
    dirty repo    · worktree has 1 uncommitted file(s): … (0/1 cleaned)
    done --close  worktree removed (branch collie/t-CLOSE kept)
                  → checkout gone, branch kept, workspace w2N closed

All sandboxes (repos, worktrees, herdr workspaces) removed afterwards.

## Phase 11 — gate on real limit percentages

collie's dashboard said 54% while claude's own panel said 30%: ccusage sums raw
tokens from local transcripts and divides by a guessed `block_budget_tokens`,
while Anthropic weights consumption by model tier and discounts cache reads.
The denominator was never calibrated (`learnedBlockCeiling` never fired — no
limit was ever hit), so the two could not agree.

Found the endpoint claude itself uses for that panel: `GET /api/oauth/usage`.

- [x] `core/src/quota/limits-api.ts` — parses `limits[]` (group session|weekly,
      percent). The sibling top-level keys are internal codenames (`tangelo`,
      `iguana_necktie`, `nimbus_quill`) and are deliberately not read.
- [x] Auth reads the macOS Keychain (`Claude Code-credentials`), never
      refreshes — rotating the user's token could log them out. Expired token
      => "unavailable", not "re-auth". `~/.claude/.credentials.json` is stale
      (its token expired 2026-06-27; claude refreshes the Keychain copy).
- [x] One call per 10 minutes, cached to `$COLLIE_HOME/limits.json`, so the 30s
      tick and the TUI share a snapshot. `refreshLimits()` async at tick top,
      `readLimits()` sync in the gate. Older than 40min => fall back.
- [x] `limitsAllow` gates on percentages; `quotaAllows` (ccusage) stays as the
      fallback. `week_fraction` config replaces the hardcoded 0.9.
- [x] Dashboard shows the real gauges + measurement age; doctor checks it.

Deliberate gap: no per-size percentage estimate, so the gate is a threshold
rather than "used + estimate <= cap". Inventing a size->% table would just be
the old uncalibrated guess in new units; crossing the cap mid-run is already
handled by the limit-hit scraper (requeue without burning an attempt).

### Review

    doctor        ok  claude usage API (real limit %) — session 33%, week 4%
    1st refresh   378ms, wrote limits.json
    2nd refresh   0ms, no network (inside the 10min window)
    full          limits ok: session 33%/85%, week 4%/90%
    conservative  limits ok: session 33%/35%  (the old ccusage path said
                  "blocked: block 104.1M/60.0M" at the same moment — the
                  guessed denominator was ~2x off)
    stale 45min   readLimits -> null -> ccusage fallback

Live dispatcher restarted and running on the new gate.

### Phase 11 follow-up — the gauge still spoke tokens

`gauge()` hardcoded a `M / M` suffix, so feeding it percentages rendered
`0.0M / 0M` next to a correct `33% used` — meaningless and duplicated. Split
the bar from its unit (`bar()` returns only the bar; the caller supplies the
label), then changed what the bar measures:

- [x] Bars now fill toward the FULL limit with `│` marking the dispatch cap.
      Filling toward the cap showed 33%-of-35% as a nearly-full bar, which
      reads as "about to hit the limit" — the opposite of the truth.
- [x] Any nonzero usage gets at least one cell (4% weekly rendered as an empty
      bar before). The row turns yellow once usage crosses the cap.
- [x] The ccusage fallback path uses the same shape in tokens, and its weekly
      cap now reads `week_fraction` instead of a hardcoded 0.9.

    5h session [████████│░░░░░░░░░░░░░░░] 33% · cap 35%
    week       [█░░░░░░░░░░░░░░░░░░░░│░░] 4% · cap 90%
    measured 5m ago (claude usage API)

## Phase 12 — "empty prompt" on a prompt that wasn't empty

Pressing `n` and typing the prompt on the line directly after the template
comment was rejected as empty. The guard judged by line count:

    prompt.trim().startsWith("<!--") && prompt.trim().split("\n").length <= 2

Comment line + prompt line = 2 lines, so a real prompt looked like an untouched
template. Reproduced across the realistic inputs:

    REJECTED  untouched template            (correct)
    accepted  prompt after a blank line
    REJECTED  prompt typed right after the comment   <- the bug
    accepted  comment deleted, one line

The same guard also revealed the second half: when it *did* accept, the
instruction comment was stored as part of the prompt and shipped to the
session (visible in t-20260808-5a56's stored prompt).

- [x] `stripPromptTemplate` in core drops the leading HTML comment; emptiness
      is judged on what remains, and only the stripped body is stored.
- [x] Both creation paths use it (TUI `n`, `collie task add`), so the CLI's
      "Lines starting with <!-- are kept" template text is gone too.
- [x] A non-zero editor exit is now reported as such instead of being folded
      into "empty prompt".

Verified end-to-end with a fake $EDITOR that writes the prompt immediately
after the comment line: both paths create the task with
`prompt: "fix the login bug"`.

## Phase 13 — stacked board for narrow (mobile) terminals

Six lanes side by side need ~70 columns before a title survives the accordion;
over moshi on a phone the board was unreadable.

- [x] `StackedBoard` below `NARROW_COLUMNS` (70): lanes stacked vertically,
      focused lane marked `▸`, empty lanes collapsed to nothing (the focused
      one always shows, so navigation still works).
- [x] Row budgeting, because Ink cannot scroll — anything past the last row is
      simply gone. A lane costs header + cards + the `… +N` row; forgetting
      that last one is what overflowed an 8-row terminal by 2 lines in
      testing. When even the floor doesn't fit, whole lanes are dropped into a
      trailing `… Running 1 · Review 1` summary rather than vanishing.
- [x] The selected card is always visible: its lane keeps a window around
      focusRow (`↑N` marks scrolled-past cards).
- [x] Header compacts (`1:boar 2:dash 3:conf`) — a wrapped header would eat a
      row the board had budgeted.
- [x] `Detail` was corrupt at that width (rows overlapping, prompt box border
      wrapping). Every line is now cut to the pane width, the prompt box is
      sized to the remaining rows, and repo/heartbeat/history compact.

### Review

Live, in a herdr pane forced to 44 columns with `stty cols 44 rows 20`
(herdr's `pane.split` did not actually change the geometry):

    1:boar 2:dash 3:conf          t-20260809-58de —
    ▸ Queued 0                    プロンプト調整時のキーボード挙動
      (empty)                     status     review
      Review 1                    repo       forge-neo-mobile
      プロンプト調整時のキーボード挙動  …
      Done 1                      history
      プロンプトアシスタントバグ修正   02:15:08 · → queued (tui)

Widest rendered line: 34 cells (board) / 43 (detail), both inside 44.
Tests assert no frame exceeds its row budget at 6/8/12/20 rows.

# collie refocus — 昼に投函・夜に burn-down・朝に収穫

Plan: /Users/qluto/.claude/plans/flickering-singing-mango.md
実装 = Opus サブエージェント / 最終レビュー = Fable（メインセッション）

- [x] Stage 1 — 質問ハーベスト + WIP修正（run.question, asking_limit, WIP=running のみ）
- [x] Stage 2 — 収穫ビュー（harvest.tsx 新デフォルトタブ, answer.ts, diffSummary）
- [x] Stage 3 — 予算予報ヘッダー（forecast.ts, dashboard 削除）
- [x] Stage 4 — 捕獲の軽量化（newTask 3ステップ, 即 queued）
- [x] Stage 5 — 軸削除（defer/backlog 廃止, done アーカイブ, Asking 表記）※pre-flight済: ライブ backlog 0件
- [x] Stage 6 — burn-down クォータモード（effectiveSessionFraction）
- [x] Stage 7 — presence 検出（ioreg HIDIdleTime, default off）

### Review (refocus 完了)

全7ステージ + docs 同期を main に積んだ（d3745f9 → 6fded7e、計8コミット）。
各ステージで bun test + tsc green を確認、Stage 1/5/6/7 の後に live dispatcher を
restart。最終 152 tests / 438 expects / 0 fail。

実機 herdr E2E（temp COLLIE_HOME + sandbox repo）: 投函 → 即 dispatch →
質問で blocked → run.question + runs/<id>/question.txt に捕獲 → answerPane で
返答 → 再開 → complete → review（resultSummary・answer.txt 確認）→ done →
tasks/archive/ へ移動 → pane close。全フェーズ成功。

**確認された既知の限界**（計画の「後回し」項目そのまま）: エージェントの質問が
選択肢メニュー（AskUserQuestion / permission ダイアログ）の場合、`a` のリテラル
送信 + Enter はテキストを伝えず、ハイライト中の選択肢を選んでしまう
（E2E では BLUE と答えたのに red が選ばれた）。メニュー型の質問には `J` ジャンプが
正道。次ラウンド候補: pane.read でメニューを検出したら answer overlay が選択肢
ピッカーに切り替わる構造化回答。

# Harvest からアーカイブ（done）を見返せるようにする

Plan: /Users/qluto/.claude/plans/temporal-crafting-badger.md

`d` で done にした瞬間タスクは `tasks/archive/` に移り、`listTasks()` は archive を
読まない → Board にも Harvest にも出ず「何やってたっけ」が消える、という報告への対応。

- [x] core: `listArchived(limit)`（mtime で新しい順に選び limit 件だけパース、
      `endedAt` desc で並べ直す、`limit:0` は readdir だけ = 件数）
- [x] tui/harvest: 折りたたみ行 `📦 Done N · A to open` / 展開で 4 グループ目
      （タイトル + `MM-DD HH:MM · resultSummary`）、行バジェットに折りたたみ行を計上
- [x] tui/app: `A` トグル、`listArchived` を useMemo（snap には混ぜない）、
      Detail 解決を archive にもフォールバック
- [x] keys.ts / CLAUDE.md 追記
- [x] テスト: store 2件（順序・上限・件数・archive なし home）、harvest 6件
      （折りたたみ / 空archive / 展開表示 / 展開時の行バジェット / 折りたたみ時の
      行バジェット / harvestList の連結）

### Review

`bun test` 160 pass / 0 fail、`bunx tsc --noEmit` clean。

実機確認（temp COLLIE_HOME + herdr の使い捨て workspace 2つ、どちらも close 済み）:
折りたたみ行 → `A` で 5 件展開（日時 + 要約、日本語タイトルの桁溢れなし）→ `j` で
アーカイブまでカーソル移動 → Enter で done タスクの Detail（history に review → done
まで出る）→ `d` は "d promotes a reviewed task to done" とフラッシュするだけ。

ドライブ中に判明した既存挙動（今回は触っていない）: Ink の `useInput` は複数文字の
チャンクを 1 つの `input` 文字列として渡すので、`pane.send_text "jjj"` は j 3 回に
ならない。TUI をスクリプトで駆動するときは 1 キーずつ送ること。

# Harvest / Config の可読性

- [x] cursor: `displayWidth` に絵文字（EAW=W）テーブルと FE0F/FE0E の解釈を追加、
      `padToWidth` を新設（Config のラベル列がこれで揃う）
- [x] harvest: グループ見出しを色分け（Review 緑 / Asking 黄 / Failed 赤 / Done 灰）、
      `✗` → `❌` で全マーカー 2 セル、件数は dim、フッタはキーだけシアン
- [x] harvest: グループ間・アーカイブ行の上・フッタの上に空行。ただし **全部収まる
      ときだけ**（`airy`）。狭いペインでは従来どおり 1 行も無駄にしない
- [x] config: セクション化（🕐 schedule / 🧍 presence / 🚦 dispatch / 📊 quota /
      🌱 defaults / 🐕 herdr / 📁 repos）、ラベル列 12 セルで値を揃える、
      これまで TUI から見えなかった presence と burn-down と asking_limit を表示、
      行が足りなければ 空行削除 → `… +N lines` の順で畳む
- [x] app: ConfigView に columns/rows を渡す（今まで行バジェット無視だった）
- [x] テスト: cursor 6件（絵文字幅・パディング）、config 5件（セクション/整列/
      行バジェット/狭幅/壊れた toml）、harvest に空行の有無 1件

### Review

`bun test` 172 pass / 0 fail、`bunx tsc --noEmit` clean。80/110/44 桁 × 24/20/11 行で
オーバーフロー無しを確認（テストでも幅を assert）。

実機: temp COLLIE_HOME + herdr の使い捨て workspace（close 済み）で harvest 折りたたみ /
展開 / config を目視。日本語タイトルと絵文字混在でも桁ズレなし。

# 初回インストールの config 生成 / presence の在り処

きっかけ: Config タブに `presence off` と出るのに `~/.collie/config.toml` に
`[presence]` が無い、という指摘。原因は仕様どおり（`pick` がデフォルトで埋める、
`loadConfig` は**ファイルが無いときだけ**テンプレートを書く）だが、初回インストールが
実は壊れていた。

- [x] `loadConfig`: ENOENT のときだけブートストラップするよう明示（今までは read の
      失敗を全部握りつぶしてテンプレートで上書きしていた）。`ensureDataDirs()` を先に
      呼ぶ — `~/.collie` 自体が無い新品マシンでは writeFileSync が ENOENT で落ちて
      いた（`doctor` と dispatcher は自前で ensureDataDirs していたので露見せず、
      `collie done` などの経路だけが死ぬ状態だった）。`wx` フラグで、既存ファイルや
      競合して生まれたファイルには絶対に被せない。
- [x] テスト 2件: `~/.collie` ごと存在しない状態からの初回起動（tree + config.toml
      生成、デフォルト値）、既存 config を上書きしないこと（＝機能より古い config は
      新セクションが生えず、欠けたキーはデフォルトになる）
- [x] CLAUDE.md に「config も task ファイルと同じで、既存ファイルは新セクションを
      得ない。Config タブが出すのは実効値であってファイルの文面ではない」を追記
- [x] ユーザーの `~/.collie/config.toml` に `[presence]` をコメントアウトで追記
      （リポジトリ外。追記後に loadConfig でパース確認済み）

- [x] 同じ理由で載っていなかった `dispatch.asking_limit` / `[quota.burn_down]` /
      `[forecast]` / `[done]` も、実効値と同じ内容でコメントアウト追記。追記後に
      loadConfig で全キーの値が変わっていないことを確認（コメントは無害）。

# collie new（herdr ポップアップからの投函）

- [x] core: `repoRootOf(dir)`（`--git-common-dir` 基準。`--show-toplevel` だと
      collie 自身の worktree の中で「worktree の worktree」を提案してしまう）
- [x] core: `showNotification` / `closePopup` を `herdr/notify.ts` に集約。
      done.ts のローカル notify を差し替え（同じ contract）
- [x] tui: `src/new.tsx` = 単体キャプチャフォーム。ヘッダー1行は装飾ではなく
      **IME のカーソル固定行に合わせるための必須**（TUI のタブバー1行と同じ高さ）
- [x] tui: `editInEditor` に `restoreAltScreen` オプション（単体コマンドは
      $EDITOR の後に alt screen へ戻ってはいけない — 最後の出力が消える）
- [x] cli: `collie new [--popup]`。`@collie/tui/new` サブパスから遅延 import
      （board / harvest をポップアップに引きずり込まない）
- [x] test: 標準入力行が REPO_ROW / TITLE_ROW と一致することを assert（定数を
      export して両方から参照）
- [x] `~/.config/herdr/config.toml` に `prefix+t` の `type = "popup"` を追記。
      `herdr config check` → ok、`herdr server reload-config` → applied
- [x] 実機: 使い捨て workspace で `collie new` を通し、cwd のリポジトリが候補の
      先頭に出ること・日本語タイトル・$EDITOR・タスク生成・`queued <id>` 表示まで
      確認。`--popup` をポップアップ外で使ってもハングしない（popup_not_open は握る）
- [ ] **人間の確認待ち**: 実際に ctrl+j → t でポップアップが開くか。keybinding は
      herdr のキー処理で捕まるため `pane.send_keys` からは発火できない（PTY に
      書くだけなので素通りする）。

# ⚠ herdr 0.8.0 で dispatch が壊れている（0.7.1 → 0.8.0 の非互換）

`agent.start` が `{name, kind, pane_id, args?, timeout_ms?}` になり、**レイアウトを
作らなくなった**（既存のシェルペインを乗っ取る）。collie は `{name, argv, cwd,
workspace_id, env, focus}` を送っているので `invalid_request: missing field 'kind'`
で必ず失敗する。unknown フィールドは今も黙って捨てられるので、`kind` を足すだけでは
cwd/env/argv が全部落ちて動かない。現在キューは空なので実害は出ていない。

移行の形（実測済み）:
- ペインを先に作る: `workspace.create` は `--env` を取る／`pane.split` は
  `--cwd --env` を取る／**`worktree.create` はどちらも取らない**
- そのペインに `agent.start {name, kind:"claude", pane_id, args:[...]}`
- 作った workspace のルートペインが**そのままエージェントのペイン**になるので、
  今の「ルートペインを閉じる」処理は削除する
- ついでに: `agent.prompt`（text + Enter をアトミックに、bracketed-paste 対応、
  `wait` で idle/done/blocked まで待つ）が inject + エコー検証 + Enter を置き換える。
  `agent.wait` / `pane.wait_for_output` / `events.wait` も実装済みで、2秒ポーリングの
  ループを畳める

### Review（0.8.0 移行）

dispatch を書き換えて実機 E2E で両パス緑。

- ペイン生成を分離: worktree タスクは `worktree.create` → **`tab.create`**
  （cwd + env を取れる唯一の手段）、非 worktree は `workspace.create` の
  ルートペインをそのまま使う（cwd + env 付きで生まれるので追加のタブが要らない）。
  「自分が作ったものだけ閉じる」規則は `ownedRootPaneId` に残した
- `agent.start {name, kind:"claude", pane_id, args, timeout_ms}`。実測で分かった罠:
  1. ログインシェルがプロンプトに到達するまで `agent_pane_busy` で断られる
     → 固定 sleep ではなく **リトライ**（zshrc が重いと 1 秒では足りない）
  2. **起動を始めた時点で返る**。数秒間 named agent は存在せず、`agent.prompt` は
     `agent_not_ready` を返す → readiness は結局こちらの仕事
- readiness は `agent.get` の **`interactive_ready === true` かつ `name` が自分**。
  `agent_status` は使わない（スクリーン読みなので、シェルが idle なだけのペインも
  idle と読める＝最初の実装が誤って先に進んだ原因）
- 注入は `agent.prompt`（text + Enter アトミック）に置換。send → pane.read で
  エコー検証 → send_keys Enter の 3 段が消えた。`agent_not_ready` のときだけ 3 回まで再試行
- 実機 E2E（temp COLLIE_HOME + サンドボックス git リポジトリ、後片付け済み）:
  - worktree: 起動 → folder-trust 自動確認 → prompt → running → **review**、
    ブランチ `collie/t-…` に HELLO.md のコミット。hooks.log に session-start が出て
    いる = **COLLIE_TASK_ID がペイン経由でちゃんと claude に届いている**
  - 非 worktree: 同上、main に `append second` のコミット
