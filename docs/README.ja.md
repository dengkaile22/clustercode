# clustercode

**OpenCode のための長時間走行エージェントクラスタ。**
モデル自身がタスク DAG を書き、プラグインが毎ターンの終わりに次のバトンを渡し、
チームメンバーが席を交代しながら、キューが空になるまで走り続けます。

[English](../README.md) · [简体中文](README.zh-CN.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Português](README.pt-BR.md)

[![check](https://github.com/dengkaile22/clustercode/actions/workflows/ci.yml/badge.svg)](https://github.com/dengkaile22/clustercode/actions/workflows/ci.yml)

---

## なぜ必要か

OpenCode V2 はプラグイン API（`Plugin.define`、2.x）を書き直しました。1.x 向けのプラグインは
2.x では読み込めません。V2 はバックグラウンド subagent、圧縮、ウォーミングを提供しますが、
無人実行に必要な次の二つは提供しません。

1. **継続** — ターンが終わっても次のターンを始めるものがありません。人間が Enter を押し続けることになります。
2. **席の交代** — 計画・実装・レビュー・テストが交代するのではなく、1 つのエージェントが全部やります。

`clustercode` が足すのはこの二つと、24 時間放っておいても大丈夫にするためのガードです。

## 機能

| 機能 | 内容 |
|---|---|
| **タスク DAG** | タスク間に `dependsOn`。依存がすべて `done` になるまで実行できません。 |
| **自動プランニング** | `cluster_auto({ goal })` がセッション外で 1 回だけモデルを呼び、目標を DAG に変換します。会話は汚しません。 |
| **席のローテーション** | メンバーは実在のエージェントファイル（`clustercode-<id>.md`）。ターン間で `switchAgent` により交代します。タスク側でメンバーを指名できます。 |
| **検証ゲート** | `done` にすると `verify` コマンドを実際に実行。終了コードが非 0 なら更新を拒否し、出力を返します。 |
| **24 時間ハートビート** | `heartbeat: true` なら、アイドル状態のセッションをクールダウン後に起こし直します。中断された実行が自力で再開します。 |
| **ガード** | バックグラウンド作業、キュー完了、デッドロック、ターン上限、停滞を、1 か所・1 つの順序で判定。 |
| **3 つの入口** | サーバー（フック/ツール/RPC）、TUI（フッター表示 + `/cluster` パネル）、Desktop（サイドパネル + 入力欄のカプセル + メニュー）。 |
| **追加と再試行** | `cluster_plan({ append: true })` で実行中のキューに追加。`cluster_retry` で失敗タスクを戻せます。 |

## 設計原則

7 つのルール。それぞれにテストがあります。[design.md](design.md) に
原則 → モジュール → テストの対応表と、元プロジェクトとの意図的な差異をまとめています。

1. **トリガーは 1 つ、スケジューラも 1 つ。** idle フックもハートビートも `decide()` を呼びます。
2. **`resume: true` がループを閉じる。** これが無いと、アイドル状態は来ない起床を待ち続けます。
3. **自己評価ではなく証拠。** `done` は受け入れコマンドを実際に実行します。
4. **前提が壊れたら止める。** 失敗した依存は満たされず、デッドロックは理由付きで即停止します。
5. **既定で譲る。** バックグラウンドが優先、権限と再試行は他プラグインの担当、システムカードは
   一定に保ちプロンプトキャッシュを守ります。
6. **ファイルが API。** 席は管理された markdown ファイルで、手書きファイルは決して触りません。
7. **データ経路は 1 本。** スナップショット → RPC → 両 UI、表示文言は共通関数。

## インストール

クローンしたら、`~/.config/opencode/opencode.json` で**ディレクトリ**（ファイルではない）を指定します。

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["C:/Users/you/Desktop/clustercode"]
}
```

ホストは `package.json` の `exports` から各半分を見つけます。

| exports | 半分 | 内容 |
|---|---|---|
| `.` | サーバー | ツール、フック、コマンド、RPC、ハートビート |
| `./tui` | ターミナル | フッターの状態表示、`/cluster` パネル |
| `./gui-experimental` | デスクトップ | サイドパネル、入力欄のカプセル、メニュー（`dist/*.cjs`） |

運用上の注意は 2 つです。

- デスクトップ側は**ビルド済み**である必要があります。クローン直後に `npm run build` を実行してください。
- ホストは起動時に**一度だけ** `exports` を調べます。`exports` を変えた場合や GUI を再ビルドした場合は、
  サーバーとデスクトップアプリを再起動してください。`opencode reload` は設定を読み直すだけです。
  `npm run check:entry` で事前に確認できます。

OpenCode 2.x のプラグインホスト（`@opencode/plugin >= 2.0.27 < 3`）が必要です。開発スクリプトは Node 22.18+。

## クイックスタート

1. OpenCode を再起動してプラグインを読み込みます。
2. **Shift+Tab** で `clustercode` エージェントに切り替えます。このモードは、モデルに仕事をキューへ
   渡させるために存在します。
3. そのまま依頼するか、ツールを直接呼びます。

```
cluster_auto({ "goal": "設定ローダに --json オプションを追加し、テストとドキュメントも書く" })
```

```
cluster_plan({
  "goal": "インポータを堅くする",
  "tasks": [
    { "id": "t1", "title": "10MB を超えるファイルを拒否する", "verify": "node test/import.test.ts" },
    { "id": "t2", "title": "上限を文書化する", "dependsOn": ["t1"] }
  ],
  "maxRounds": 5
})
```

4. 進捗確認: `/cluster` でパネルを開きます。TUI のフッターには
   `cluster 2/5 · turn 3 · coder` が出ます。デスクトップでは入力欄の上に同じ進捗のカプセルが出ます。
5. 止めるときは `/cluster-stop`、再開は `/cluster-resume`。

最初のうちは `maxRounds: 5` を推奨します。計画が信頼できるようになってから外してください。
`maxRounds: null` と緩い権限設定の組み合わせは、本当にキューが空になるまで走ります。

## ツール

| ツール | 役割 |
|---|---|
| `cluster_auto` | 目標を渡すと DAG を生成して実行開始。チームが無ければ既定のメンバーを作ります。 |
| `cluster_plan` | 明示的なキュー。`dependsOn`、`verify`、`member`、`maxRounds`、`maxStagnant`、`heartbeat`、`append`。 |
| `cluster_update` | `pending` / `running` / `done` / `failed` を報告。`done` は検証ゲートを通ります。 |
| `cluster_status` | ターン、キュー、次の席、依存待ち、ハートビート、停止理由。 |
| `cluster_team` | チームの作成・入れ替え。`adoptCluster: true` で手書きの `clustercode.md` を引き継ぎます。 |
| `cluster_retry` | 失敗タスクを `pending` に戻し、停止理由を消して再開します。 |

コマンド: `/cluster-stop`、`/cluster-resume`、`/cluster`（パネル）。

## 既定のチーム

`cluster_team({ members: [...] })` で置き換えます。各メンバーは `id`、`role`、`color`、`extra`、`model` を持てます。

| id | 役割 | 補足 |
|---|---|---|
| `architect` | 分解、インターフェース確定、計画作成 | 実装コードは書きません |
| `coder` | 計画に沿って実装 | 自分の変更を自分で検証 |
| `reviewer` | 読み取り専用レビュー | frontmatter で `edit:*` 呼び出しを拒否 |
| `tester` | テスト実行、バグ再現、受け入れ条件の証明 | 実際の出力だけを信じます |

`reviewer` の読み取り専用は**ポリシー**による制限で、サンドボックスではありません。ファイルに
触れさせたくない場合は OS レベルで制限してください。

## 1 ターンの流れ

```
experimental.idle
   ├─ バックグラウンド作業が残っている? → 待つ（終了時に再度起こされます）
   ├─ キューが完了?                     → 停止（finished）
   ├─ グラフがデッドロック?             → 停止（deadlock）
   ├─ ターン上限に到達?                 → 停止（max-rounds）
   ├─ 次ターンが停滞になる?             → 停止（stagnant）
   └─ それ以外
        switchAgent(次の席)  → cursor は成功時のみ進む
        round += 1、保存、スナップショット公開
        synthetic({ resume: true, text: "ターン N、タスク tX、cluster_update で報告" })
```

`resume: true` が要です。これが無いと、注入したテキストは次の起床を待ちますが、アイドル状態の
セッションにはその起床が来ません。実行は静かに止まります。ハートビートも同じ `decide()` を
通るため、ターン上限に達したクラスタはそこで停止し、余分に 1 ターン起こされることはありません。

## アーキテクチャ

```
core（純粋・テスト可能）
  state.ts      DAG、ローテーション、カウンタ、状態フィンガープリント
  scheduler.ts  decide() + commit()：ガード順序はここだけ
  plan.ts       目標 → DAG、JSON 修復、循環検出
  store.ts      キャッシュ付き・直列書き込みの永続化 + FileStorage
        │
server（src/index.ts）
  idle フック · システムカード · コマンド · ツール · ハートビート · スナップショット RPC
        │  clustercode.snapshot { get } → SnapshotView
        ├──────────────┬─────────────────────────┐
   TUI（src/tui.tsx）                 Desktop（dist/gui-experimental.cjs）
   フッター表示 + /cluster パネル      サイドパネル + カプセル + コマンド
```

UI の 2 つの半分は RPC しか読みません。サーバーのメモリにもディスクにも触れないため、遠隔の
サーバーに繋いだデスクトップでもローカルと同じように動きます。表示文言は `status.ts` を共有するので、
フッターとパネルで数字が食い違うことはありません。

## ガードとコスト

- **停滞**: 既定で 12 ターン連続して状態が変わらないと停止。`maxStagnant: 0` で無効化。その場合
  `maxRounds` が唯一の歯止めになります。
- **ターン上限**: 既定は `null`。最初の何回かは数値を設定してください。
- **デッドロック**: 依存の循環や上流の失敗は、停滞カウンタが動く前に理由付きで即停止します。
- **ハートビート**: `cluster_auto` は既定で有効、`cluster_plan` は既定で無効。最小 15 秒、既定 60 秒。
  ターン上限と停滞ガードを尊重します。

判定はすべて `decide()` にあり、ルールの写しは 1 つだけです。

## 共存

clustercode は、他のプラグインがすでに担っている領域を意図的に取りません。

| 領域 | 担当 |
|---|---|
| 権限、長い shell のタイムアウト | お使いの権限プラグイン（`permission.evaluate` は登録しません） |
| 再試行のバックオフ | お使いの再試行プラグイン（`retry` は登録しません。2 つのプラグインが `event.decision` を書くと最後の登録が勝つため） |
| システムプロンプト | ホスト。clustercode は一定のカードを 1 ターン 1 回だけ追加します |
| 席ごとのモデル | あなた。メンバーの `model` フィールドで指定します |

`retry` を両方が登録すれば、両方が勝つことはありません。だからこのプラグインは退きます。

## 検証済み

```
npm run check
  型チェック（tsc --noEmit、TSX 含む）
  187 個のアサーション（node --test、モデルもネットワークも不要）
  ビルド: dist/gui-experimental.cjs + TUI コンパイル確認
  入口検査: server / tui / desktop すべて解決
  TUI 配線検査 + desktop 配線検査
```

**検証していない**こと: 実際の描画（生きた TUI / デスクトップアプリが必要）と、実モデルでの
完全な無人実行（トークンが必要）。それ以外はテストで担保しています。

## 開発

```powershell
npm install
npm run check        # 上記を順番に実行
npm run test         # アサーションのみ
npm run typecheck
npm run build        # desktop バンドル + TUI コンパイル確認
npm run check:entry  # ホストの exports 検査を再現
```

テストは `CLUSTERCODE_AGENTS_DIR` でエージェントディレクトリを一時領域へ向けるため、実際の
`~/.config/opencode/agents` には書き込みません。

`docs/development.md` に、`opencode/` 以下に置いた OpenCode ソースの参照コピーの使い方と、
ホスト API の再確認方法をまとめています。

## 既知の制限

- **単一レーン**: 1 セッションにつき 1 ターンずつ。並列性はバックグラウンド subagent のもので、
  idle フックは意図的に彼らへ道を譲ります。
- **`cluster_plan` は既定でキューを置き換えます**。追加するには `append: true`。
- **`experimental.idle` は実験的フック**です。ホスト更新で形が変わり得るため、更新後はまず
  `npm run check` を実行してください。
- **検証ゲートはポリシー層**であり、サンドボックスではありません。
- **RPC の output schema はスナップショットの全フィールドを列挙する必要があります**。ホストは
  閉じたオブジェクトとしてデコードするため、1 つ欠けると `rpc.invalid_output` になり、パネルが
  空のままになります。`test/rpc.test.ts` が実データとスキーマを突き合わせます。
- **空文字は「無し」**を意味します。`currentMember`、`stoppedReason`、`member`、`color`、`verify` は
  `""` で、`null` は使いません。
- **描画には再起動が必要**です。ホストは起動時にしか入口を調べません。

## 系譜

`clustercode` は、中国語で書かれた OpenCode V2 プラグイン **无限制 agent 群**
（`unlimited-agent-cluster`）のアイデアを独立に書き直したものです。変更点:

- 実行時文言・コメント・ドキュメントを英語に。
- ファイル名を `clustercode` / `clustercode-<id>` にし、両プラグインが共存できるように。
- idle フックとハートビートで 1 つの `decide()` を共有（ガード順序の二重管理を解消）。
- 人が読む理由に加えて機械可読な `stoppedCode`。
- 増分 `append` と `cluster_retry`。
- RPC ペイロードとスキーマの網羅テスト（両パネルが空になる原因だったバグ）。

## ライセンス

MIT。[LICENSE](../LICENSE) を参照してください。
