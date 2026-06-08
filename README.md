# Google Calendar 多者間同期スクリプト

複数のGoogleカレンダー間で予定を自動的に相互招待するGoogle Apps Scriptです。2者でも3者以上でも動きます（全ペアを双方向同期する完全メッシュ）。

## 仕組み

イベントのコピーではなく、**各カレンダーをゲストとして自動追加**する方式です。

`CONFIG.CALENDAR_IDS` に列挙したカレンダー同士を、全ペアで相互にゲスト追加します。

- 例: `[B, P, C]` → `B↔P` / `B↔C` / `P↔C` をすべて双方向同期

送信元カレンダーごとに `syncToken` を1つ持ち、1回の走査で未招待のゲストをまとめて追加します（同じ送信元から複数の宛先に配っても差分取得が壊れません）。

### 招待された予定の自動承認

KosmoTime経由や他人主催で招待された予定は、自分がorganizerではないため `responseStatus: 'accepted'` でゲスト追加してもGoogle側で `needsAction` に戻されます。

そのため、**他のいずれかのカレンダーで承認済み**の予定について、こちら側でも `responseStatus` を `accepted` に書き換える `autoAcceptSynced` が `syncAll` 内で動きます。結果として、**どれか1つで参加登録すれば、残りも自動承認**されます。

### visibility: private の効果

`CONFIG.PRIVATE_SOURCE_IDS` に入れたカレンダー「発」の予定は `visibility: private` で同期されます。同期先カレンダーを第三者と共有しても、その予定は「予定あり」としか表示されません（本人は詳細を確認できます）。業務予定の詳細を隠したい場合に使います。

## セットアップ

1. [script.google.com](https://script.google.com) で新しいプロジェクトを作成
2. `sync.gs` の内容を貼り付け
3. 左メニュー「サービス」→「Google Calendar API」を追加
4. `CONFIG.CALENDAR_IDS` に同期したいカレンダーIDを列挙（提携先などを足す時はここに追記）
5. 全カレンダーを相互に共有（編集権限付き）。**すべてのカレンダーに実行アカウントの編集権限が必要**
6. `syncAll` を実行（初回は権限の承認が求められます）
7. `setupTrigger` を実行（5分間隔の自動実行が設定されます）

### カレンダーを追加するとき

`CONFIG.CALENDAR_IDS` に追記し、そのカレンダーを他の全カレンダーと相互に編集権限付きで共有するだけです。`syncAll` が次回実行時から自動で全ペアに反映します。

## 関数一覧

| 関数 | 用途 |
|---|---|
| `syncAll` | 同期を即時実行 |
| `setupTrigger` | 5分間隔のトリガーを設定 |
| `resetSync` | syncTokenをリセット（期間変更時などに使用） |
