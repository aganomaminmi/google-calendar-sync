// ============================================
// Google Calendar 双方向同期スクリプト（招待方式）
// ============================================
// B(Business) → P(Personal): Pをゲスト追加（visibility: private）
// P(Personal) → B(Business): Bをゲスト追加
//
// セットアップ手順:
// 1. script.google.com で新しいプロジェクトを作成
// 2. このコードを貼り付け
// 3. 左メニュー「サービス」→「Google Calendar API」を追加
// 4. 下の CONFIG にカレンダーIDを入力
// 5. setupTrigger() を実行（5分間隔のトリガーが設定される）
// 6. syncAll() を手動実行して初回同期（権限の承認を求められます）
// ============================================

// ---- 設定 ----
var CONFIG = {
  B_CALENDAR_ID: 'your-business@example.com',
  P_CALENDAR_ID: 'your-personal@example.com',
};

var PROPS = PropertiesService.getScriptProperties();

// ---- メイン ----

function syncAll() {
  addGuests(CONFIG.B_CALENDAR_ID, CONFIG.P_CALENDAR_ID, true);
  addGuests(CONFIG.P_CALENDAR_ID, CONFIG.B_CALENDAR_ID, false);
  autoAcceptSynced(CONFIG.B_CALENDAR_ID, CONFIG.P_CALENDAR_ID);
  autoAcceptSynced(CONFIG.P_CALENDAR_ID, CONFIG.B_CALENDAR_ID);
  console.log('同期完了');
}

function addGuests(srcId, guestEmail, setPrivate) {
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
          if (innerE.message && innerE.message.includes('410')) throw innerE;
          console.warn('list リトライ ' + (attempt + 1) + '/3: ' + innerE.message);
          Utilities.sleep(2000 * (attempt + 1));
        }
      }
      if (!response) throw new Error('list取得失敗');
      allEvents = allEvents.concat(response.items || []);
      pageToken = response.nextPageToken;
      nextSyncToken = response.nextSyncToken;
    } while (pageToken);
  } catch (e) {
    if (e.message && e.message.includes('410')) {
      console.log(srcId + ': syncToken期限切れ。フルリセットします');
      PROPS.deleteProperty(tokenKey);
      addGuests(srcId, guestEmail, setPrivate);
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

    // 既にゲストに入っているかチェック
    var attendees = event.attendees || [];
    var alreadyInvited = false;
    for (var j = 0; j < attendees.length; j++) {
      if (attendees[j].email === guestEmail) {
        alreadyInvited = true;
        break;
      }
    }

    if (alreadyInvited) {
      skipped++;
      continue;
    }

    // ゲスト追加
    attendees.push({
      email: guestEmail,
      responseStatus: 'accepted',
    });

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

// 他人主催の予定でパートナー側がacceptedの場合、自分のresponseStatusをacceptedに更新する。
// organizer以外がpatchで他人のresponseStatusを変えられないため、自分のカレンダー側で書き換える必要がある。
function autoAcceptSynced(myCalendarId, partnerEmail) {
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
        console.warn('autoAccept list リトライ ' + (attempt + 1) + '/3: ' + e.message);
        Utilities.sleep(2000 * (attempt + 1));
      }
    }
    if (!response) throw new Error('autoAccept list取得失敗');
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
    var partnerEntry = null;
    for (var j = 0; j < attendees.length; j++) {
      var a = attendees[j];
      if (a.self === true || a.email === myCalendarId) myEntry = a;
      if (a.email === partnerEmail) partnerEntry = a;
    }

    if (!myEntry || myEntry.responseStatus !== 'needsAction') continue;
    if (!partnerEntry || partnerEntry.responseStatus !== 'accepted') continue;

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
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
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
  PROPS.getKeys().forEach(function(key) {
    PROPS.deleteProperty(key);
  });
  console.log('同期データをリセットしました');
}
