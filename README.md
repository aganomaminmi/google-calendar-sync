# Google Calendar 双方向同期スクリプト

2つのGoogleアカウント間でカレンダー予定を自動的に相互招待するGoogle Apps Scriptです。

## 仕組み

イベントのコピーではなく、**相手アカウントをゲストとして自動追加**する方式です。

- **B(Business) → P(Personal)**: Pをゲスト追加（`visibility: private` 付き）
- **P(Personal) → B(Business)**: Bをゲスト追加

### visibility: private の効果

Bの予定がPのカレンダーに表示されますが、Pのカレンダーを第三者と共有した場合、Bの予定は「予定あり」としか表示されません。自分自身は詳細を確認できます。

## セットアップ

1. [script.google.com](https://script.google.com) で新しいプロジェクトを作成
2. `sync.gs` の内容を貼り付け
3. 左メニュー「サービス」→「Google Calendar API」を追加
4. `CONFIG` のカレンダーIDを自分のメールアドレスに変更
5. 両アカウントのカレンダーを相互に共有（編集権限付き）
6. `syncAll` を実行（初回は権限の承認が求められます）
7. `setupTrigger` を実行（5分間隔の自動実行が設定されます）

## 関数一覧

| 関数 | 用途 |
|---|---|
| `syncAll` | 同期を即時実行 |
| `setupTrigger` | 5分間隔のトリガーを設定 |
| `resetSync` | syncTokenをリセット（期間変更時などに使用） |
