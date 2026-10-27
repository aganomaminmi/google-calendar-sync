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

// 連続失敗の回数を数えるキー。Google 側の瞬断1回では通知せず、
// FAIL_STREAK_THRESHOLD 回続いたときだけ throw してトリガーの失敗通知を出す。
var FAIL_STREAK_KEY = 'failStreak';
var FAIL_STREAK_THRESHOLD = 3; // 5分間隔 × 3 = 15分連続で失敗したら通知

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
      // patch が失敗し続けると syncToken が進まないまま止まるので、失敗件数も errors 扱いにする
      if (addGuests(src, guests, setPrivate) > 0) {
        errors.push(src + '(ゲスト追加失敗)');
      }
    } catch (e) {
      console.error('スキップ addGuests (' + src + '): ' + e.message);
      errors.push(src);
    }
  }

  // 参加・不参加・未定の回答を全カレンダーで揃える
  errors = errors.concat(syncResponses(ids));

  // 失敗を握りつぶすと同期が止まったままでも何も届かないので、連続失敗だけは通知する。
  // 1回きりの失敗（Google 側の瞬断）は次の実行で回復するため黙って抜ける。
  if (errors.length) {
    var streak = Number(PROPS.getProperty(FAIL_STREAK_KEY) || 0) + 1;
    PROPS.setProperty(FAIL_STREAK_KEY, String(streak));
    console.warn('一部のカレンダーで失敗（' + streak + '回連続）: ' + errors.join(', '));
    if (streak >= FAIL_STREAK_THRESHOLD) {
      throw new Error(
        '同期が' + streak + '回連続で失敗しています（対象: ' + errors.join(', ') + '）'
      );
    }
    return;
  }

  PROPS.deleteProperty(FAIL_STREAK_KEY);
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
// 戻り値: ゲスト追加に失敗したイベント件数（0 なら全件成功）
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
          if (attempt < 2) Utilities.sleep(2000 * (attempt + 1));
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
      return addGuests(srcId, guestEmails, setPrivate);
    }
    throw e;
  }

  var added = 0, skipped = 0, failed = 0;

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

    // 自分が主催者で、同期先のカレンダー以外のゲストがいない予定は、ゲストからも変更できるようにする
    var allowModify = false;
    if (event.organizer && event.organizer.self && event.guestsCanModify !== true) {
      allowModify = attendees.every(function (a) {
        return a.email === srcId || CONFIG.CALENDAR_IDS.indexOf(a.email) !== -1;
      });
    }

    if (newlyAdded === 0 && !allowModify) {
      skipped++;
      continue;
    }

    var patch = { attendees: attendees };

    if (allowModify) {
      patch.guestsCanModify = true;
    }

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
          console.error('ゲスト追加失敗 (' + event.id + '): ' + e.message);
        } else {
          Utilities.sleep(2000 * (attempt + 1));
        }
      }
    }
    if (patchSuccess) { added++; } else { failed++; }
  }

  // 1件でも patch に失敗していたら syncToken を進めない。
  // 進めると差分同期で次回以降そのイベントが返らず、ゲスト未追加のまま取りこぼしが永続化する。
  if (nextSyncToken && failed === 0) {
    PROPS.setProperty(tokenKey, nextSyncToken);
  } else if (failed > 0) {
    console.warn(srcId + ': ' + failed + '件失敗したため syncToken を進めません（次回まとめて再試行）');
  }

  console.log(srcId + ': 追加=' + added + ' スキップ=' + skipped + ' 失敗=' + failed);
  return failed;
}

// 回答（responseStatus）を1文字で保存するための対応表。'-' はそのカレンダーが予定に参加していないことを表す。
var RSVP_KEY_PREFIX = 'rsvp_';
var STATUS_TO_CODE = { accepted: 'a', declined: 'd', tentative: 't', needsAction: 'n' };
var CODE_TO_STATUS = { a: 'accepted', d: 'declined', t: 'tentative', n: 'needsAction' };

// 同じ予定への回答（参加・不参加・未定）を全カレンダーで揃える。
// 前回揃えたときの各カレンダーの回答を予定ごとに記録しておき、そこから変わった回答を他のカレンダーへ写す。
// 自分の回答は自分のカレンダー側の予定でしか書き換えられないため、カレンダーごとに patch する。
// 戻り値: 失敗したカレンダー・予定の一覧（空なら全件成功）
function syncResponses(ids) {
  var errors = [];
  var copiesById = {}; // event.id -> ids と同じ並びの各カレンダーでの予定（参加していなければ null）
  var listFailed = false;

  for (var c = 0; c < ids.length; c++) {
    var events;
    try {
      events = listWindow(ids[c]);
    } catch (e) {
      console.error('スキップ syncResponses (' + ids[c] + '): ' + e.message);
      errors.push(ids[c]);
      listFailed = true;
      continue;
    }
    for (var i = 0; i < events.length; i++) {
      var event = events[i];
      if (event.eventType && event.eventType !== 'default') continue;
      if (event.status === 'cancelled') continue;
      if (!selfEntry(event, ids[c])) continue;
      if (!copiesById[event.id]) copiesById[event.id] = ids.map(function () { return null; });
      copiesById[event.id][c] = event;
    }
  }

  var stored = PROPS.getProperties();
  var updated = 0;

  Object.keys(copiesById).forEach(function (eventId) {
    var copies = copiesById[eventId];
    if (copies.filter(Boolean).length < 2) return;

    var key = RSVP_KEY_PREFIX + eventId;
    var prev = stored[key] || '';
    var current = copies.map(function (ev, c) {
      return ev ? STATUS_TO_CODE[selfEntry(ev, ids[c]).responseStatus] || 'n' : '-';
    }).join('');

    // 前回から変わった回答を集める（未回答への変化は写さない）
    var changed = {};
    for (var c = 0; c < current.length; c++) {
      var code = current[c];
      if (code !== '-' && code !== 'n' && code !== prev[c]) changed[code] = true;
    }
    var codes = Object.keys(changed);

    if (codes.length !== 1) {
      // 2つ以上のカレンダーで別々の回答に変わったときは、どちらが正しいか決められないので揃えない
      if (codes.length > 1) {
        console.warn('回答が食い違うため揃えません (' + eventId + '): ' + current);
      }
      if (prev !== current) PROPS.setProperty(key, current);
      return;
    }

    var target = codes[0];
    var ok = true;
    for (var c = 0; c < copies.length; c++) {
      if (!copies[c] || current[c] === target) continue;
      if (!patchResponses(ids[c], copies[c], ids, CODE_TO_STATUS[target])) ok = false;
    }

    // 1件でも失敗したら記録を進めず、次回も同じ変更として再試行する
    if (ok) {
      PROPS.setProperty(key, current.replace(/[adtn]/g, target));
      updated++;
    } else {
      errors.push(eventId + '(回答の反映失敗)');
    }
  });

  // 一覧の取得に失敗したカレンダーがあると記録の要否を判定できないので、そのときは掃除しない
  if (!listFailed) {
    Object.keys(stored).forEach(function (key) {
      if (key.indexOf(RSVP_KEY_PREFIX) !== 0) return;
      var copies = copiesById[key.slice(RSVP_KEY_PREFIX.length)];
      if (!copies || copies.filter(Boolean).length < 2) PROPS.deleteProperty(key);
    });
  }

  console.log('回答の反映=' + updated);
  return errors;
}

// 予定の参加者のうち、そのカレンダー自身のエントリを返す
function selfEntry(event, calendarId) {
  var attendees = event.attendees || [];
  for (var j = 0; j < attendees.length; j++) {
    if (attendees[j].self === true || attendees[j].email === calendarId) return attendees[j];
  }
  return null;
}

// calendarId 側の予定で、同期対象カレンダー全員の回答を status にして patch する。
// 古い回答のまま送ると主催者側の予定で他カレンダーの回答を巻き戻すので、全員分を揃えて送る。
function patchResponses(calendarId, event, ids, status) {
  var attendees = event.attendees || [];
  for (var j = 0; j < attendees.length; j++) {
    if (attendees[j].self === true || ids.indexOf(attendees[j].email) !== -1) {
      attendees[j].responseStatus = status;
    }
  }
  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      Calendar.Events.patch({ attendees: attendees }, calendarId, event.id, { sendUpdates: 'none' });
      return true;
    } catch (e) {
      if (attempt === 2) {
        console.error('回答の反映失敗 (' + calendarId + ' / ' + event.id + '): ' + e.message);
      } else {
        Utilities.sleep(2000 * (attempt + 1));
      }
    }
  }
  return false;
}

// 過去30日〜200日先の予定を全件取得する
function listWindow(calendarId) {
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
        response = Calendar.Events.list(calendarId, params);
        if (response) break;
      } catch (e) {
        // 404(Not Found)は未共有/ID誤りでリトライしても直らないので即諦める（syncResponses側でスキップ）
        if (e.message && e.message.includes('Not Found')) throw e;
        console.warn(calendarId + ' list リトライ ' + (attempt + 1) + '/3: ' + e.message);
        if (attempt < 2) Utilities.sleep(2000 * (attempt + 1));
      }
    }
    if (!response) throw new Error('list取得失敗（カレンダーID or 共有設定を確認）: ' + calendarId);
    allEvents = allEvents.concat(response.items || []);
    pageToken = response.nextPageToken;
  } while (pageToken);

  return allEvents;
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
