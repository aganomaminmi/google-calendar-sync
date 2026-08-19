// ============================================
// Google Calendar 多者間同期スクリプト（招待方式・完全メッシュ）
// ============================================
// CONFIG.CALENDAR_IDS に列挙したカレンダー同士を相互にゲスト追加して同期する。
// 2者でも3者以上でも動く（全ペアを相互に同期する完全メッシュ）。
//
//   例: [B, P, C] なら B↔P / B↔C / P↔C をすべて双方向同期
//
// すべてのカレンダーに対して実行アカウントが編集権限を持っている必要がある
// （= 各カレンダーを相互に編集権限付きで共有しておくこと）。
//
// セットアップ手順:
// 1. script.google.com で新しいプロジェクトを作成
// 2. このコードを貼り付け
// 3. 左メニュー「サービス」→「Google Calendar API」を追加
// 4. 下の CONFIG.CALENDAR_IDS に同期したいカレンダーIDを列挙
// 5. 全カレンダーを相互に共有（編集権限付き）
// 6. setupTrigger() を実行（5分間隔のトリガーが設定される）
// 7. syncAll() を手動実行して初回同期（権限の承認を求められます）
// ============================================

// ---- 設定 ----
var CONFIG = {
  // 同期したいカレンダーIDを列挙する。提携先などを足したい時はここに追記。
  CALENDAR_IDS: [
    'your-business@example.com',   // B: 業務
    'your-personal@example.com',   // P: プライベート
    'your-partner@example.com',    // C: 提携先
  ],

  // ここに列挙したカレンダー「発」の予定は visibility: private で同期する。
  // （相手カレンダーを第三者と共有しても「予定あり」としか見えず、詳細は本人だけ確認できる）
  // 業務予定の詳細を隠したい場合は業務カレンダーIDを入れる。
  PRIVATE_SOURCE_IDS: [
    'your-business@example.com',
    'your-partner@example.com',
  ],
};

var PROPS = PropertiesService.getScriptProperties();

// ---- メイン ----

function syncAll() {
  var ids = CONFIG.CALENDAR_IDS;
  var errors = [];

  // 各カレンダーを送信元として、それ以外の全カレンダーをゲスト追加。
  // 1つのカレンダーが失敗（未共有・ID誤り等）しても他は止めず続行する。
  for (var i = 0; i < ids.length; i++) {
    var src = ids[i];
    var guests = otherIds(ids, src);
    var setPrivate = CONFIG.PRIVATE_SOURCE_IDS.indexOf(src) !== -1;
    try {
      addGuests(src, guests, setPrivate);
    } catch (e) {
      console.error('スキップ addGuests (' + src + '): ' + e.message);
      errors.push(src);
    }
  }

  // 各カレンダーで、他のいずれかが承認済みの予定を自分側でも自動承認
  for (var k = 0; k < ids.length; k++) {
    var me = ids[k];
    try {
      autoAcceptSynced(me, otherIds(ids, me));
    } catch (e) {
      console.error('スキップ autoAccept (' + me + '): ' + e.message);
      errors.push(me);
    }
  }

  if (errors.length) {
    console.warn('一部のカレンダーで失敗（要確認）: ' + errors.join(', '));
  }
  console.log('同期完了');
}

// 自分以外のカレンダーIDを返す
function otherIds(ids, self) {
  return ids.filter(function (id) {
    return id !== self;
  });
}

// srcId のカレンダーを1回走査し、未招待の guestEmails をまとめてゲスト追加する。
// syncToken は送信元(srcId)ごとに1つなので、複数ゲストへ配っても差分取得が壊れない。
function addGuests(srcId, guestEmails, setPrivate) {
  var tokenKey = 'syncToken_' + srcId;
  var syncToken = PROPS.getProperty(tokenKey);
  var allEvents = [];
  var nextSyncToken = null;

  try {
    var pageToken = null;
    do {
      var params = { maxResults: 250 };

      if (syncToken) {
        params.syncToken = syncToken;
      } else {
        var past = new Date();
        past.setDate(past.getDate() - 30);
        params.timeMin = past.toISOString();
        var future = new Date();
        future.setDate(future.getDate() + 200);
        params.timeMax = future.toISOString();
      }

      if (pageToken) {
        params.pageToken = pageToken;
      }

      var response = null;
      for (var attempt = 0; attempt < 3; attempt++) {
        try {
          response = Calendar.Events.list(srcId, params);
          if (response) break;
        } catch (innerE) {
          // 410(syncToken失効)はメッセージに「410」が含まれない形で来るので文言でも判定する
          if (innerE.message && (innerE.message.includes('410') || innerE.message.includes('full sync is required'))) throw innerE;
          // 404(Not Found)は未共有/ID誤りでリトライしても直らないので即諦める（syncAll側でスキップ）
          if (innerE.message && innerE.message.includes('Not Found')) throw innerE;
          console.warn(srcId + ' list リトライ ' + (attempt + 1) + '/3: ' + innerE.message);
          Utilities.sleep(2000 * (attempt + 1));
        }
      }
      if (!response) throw new Error('list取得失敗（カレンダーID or 共有設定を確認）: ' + srcId);
      allEvents = allEvents.concat(response.items || []);
      pageToken = response.nextPageToken;
      nextSyncToken = response.nextSyncToken;
    } while (pageToken);
  } catch (e) {
    if (e.message && (e.message.includes('410') || e.message.includes('full sync is required'))) {
      console.log(srcId + ': syncToken期限切れ。フルリセットします');
      PROPS.deleteProperty(tokenKey);
      addGuests(srcId, guestEmails, setPrivate);
      return;
    }
    throw e;
  }

  var added = 0, skipped = 0;

  for (var i = 0; i < allEvents.length; i++) {
    var event = allEvents[i];

    // 通常の予定以外はスキップ
    if (event.eventType && event.eventType !== 'default') {
      skipped++;
      continue;
    }

    // キャンセル済みはスキップ
    if (event.status === 'cancelled') {
      skipped++;
      continue;
    }

    var attendees = event.attendees || [];

    // 未招待のゲストだけを追加
    var newlyAdded = 0;
    for (var g = 0; g < guestEmails.length; g++) {
      var guestEmail = guestEmails[g];
      var alreadyInvited = false;
      for (var j = 0; j < attendees.length; j++) {
        if (attendees[j].email === guestEmail) {
          alreadyInvited = true;
          break;
        }
      }
      if (alreadyInvited) continue;

      attendees.push({
        email: guestEmail,
        responseStatus: 'accepted',
      });
      newlyAdded++;
    }

    if (newlyAdded === 0) {
      skipped++;
      continue;
    }

    var patch = { attendees: attendees };

    if (setPrivate) {
      patch.visibility = 'private';
    }

    var patchSuccess = false;
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        Calendar.Events.patch(patch, srcId, event.id, { sendUpdates: 'none' });
        patchSuccess = true;
        break;
      } catch (e) {
        if (attempt === 2) {
          console.error('ゲスト追加失敗 (' + event.id + '): ' + e.message + ' | ' + (event.summary || ''));
        } else {
          Utilities.sleep(2000 * (attempt + 1));
        }
      }
    }
    if (patchSuccess) { added++; } else { skipped++; }
  }

  if (nextSyncToken) {
    PROPS.setProperty(tokenKey, nextSyncToken);
  }

  console.log(srcId + ': 追加=' + added + ' スキップ=' + skipped);
}

// 他人主催の予定でいずれかのパートナーがacceptedの場合、自分のresponseStatusをacceptedに更新する。
// organizer以外がpatchで他人のresponseStatusを変えられないため、自分のカレンダー側で書き換える必要がある。
function autoAcceptSynced(myCalendarId, partnerEmails) {
  var past = new Date();
  past.setDate(past.getDate() - 30);
  var future = new Date();
  future.setDate(future.getDate() + 200);

  var allEvents = [];
  var pageToken = null;
  do {
    var params = {
      maxResults: 250,
      timeMin: past.toISOString(),
      timeMax: future.toISOString(),
      showDeleted: false,
    };
    if (pageToken) params.pageToken = pageToken;

    var response = null;
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        response = Calendar.Events.list(myCalendarId, params);
        if (response) break;
      } catch (e) {
        // 404(Not Found)は未共有/ID誤りでリトライしても直らないので即諦める（syncAll側でスキップ）
        if (e.message && e.message.includes('Not Found')) throw e;
        console.warn(myCalendarId + ' autoAccept list リトライ ' + (attempt + 1) + '/3: ' + e.message);
        Utilities.sleep(2000 * (attempt + 1));
      }
    }
    if (!response) throw new Error('autoAccept list取得失敗（カレンダーID or 共有設定を確認）: ' + myCalendarId);
    allEvents = allEvents.concat(response.items || []);
    pageToken = response.nextPageToken;
  } while (pageToken);

  var accepted = 0;

  for (var i = 0; i < allEvents.length; i++) {
    var event = allEvents[i];

    if (event.eventType && event.eventType !== 'default') continue;
    if (event.status === 'cancelled') continue;

    var attendees = event.attendees || [];
    var myEntry = null;
    var anyPartnerAccepted = false;
    for (var j = 0; j < attendees.length; j++) {
      var a = attendees[j];
      if (a.self === true || a.email === myCalendarId) myEntry = a;
      if (partnerEmails.indexOf(a.email) !== -1 && a.responseStatus === 'accepted') {
        anyPartnerAccepted = true;
      }
    }

    if (!myEntry || myEntry.responseStatus !== 'needsAction') continue;
    if (!anyPartnerAccepted) continue;

    myEntry.responseStatus = 'accepted';

    var ok = false;
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        Calendar.Events.patch({ attendees: attendees }, myCalendarId, event.id, { sendUpdates: 'none' });
        ok = true;
        break;
      } catch (e) {
        if (attempt === 2) {
          console.error('自動承認失敗 (' + event.id + '): ' + e.message + ' | ' + (event.summary || ''));
        } else {
          Utilities.sleep(2000 * (attempt + 1));
        }
      }
    }
    if (ok) accepted++;
  }

  console.log(myCalendarId + ': 自動承認=' + accepted);
}

// ---- セットアップ ----

function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'syncAll') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('syncAll')
    .timeBased()
    .everyMinutes(5)
    .create();

  console.log('5分間隔のトリガーを設定しました');
}

// ---- ユーティリティ ----

function resetSync() {
  PROPS.getKeys().forEach(function (key) {
    PROPS.deleteProperty(key);
  });
  console.log('同期データをリセットしました');
}
