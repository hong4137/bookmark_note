/**
 * 설치용 함수 모음 — 순서대로 한 번씩 실행하면 됩니다.
 * 편집기 위쪽 함수 선택창에서 골라 ▶ 실행, 결과는 [실행 로그]에 찍힙니다.
 */

// ═══════════════ 여기 두 군데만 채우세요 ═══════════════

/** 1단계에서 채울 값 */
const SETUP = {
  TELEGRAM_TOKEN: '',  // @BotFather 에서 새 봇을 만들고 받은 토큰
  GEMINI_API_KEY: ''   // https://aistudio.google.com/apikey
};

/** 메시지를 몇 분마다 확인할지. 1이면 가장 빠르지만 하루 실행시간을 가장 많이 쓴다 */
const POLL_MINUTES = 1;

/** (선택) 허용목록_직접추가 로 넣을 챗 ID */
const CHAT_ID_TO_ADD = '';

// ═══════════════════════════════════════════════════


/** 1단계 — 토큰과 키 저장 */
function step1_설정값저장() {
  const props = PropertiesService.getScriptProperties();

  Object.keys(SETUP).forEach(function (k) {
    if (!SETUP[k]) throw new Error('SETUP.' + k + ' 가 비어 있습니다.');
    props.setProperty(k, SETUP[k].trim());
  });

  console.log('저장 완료. 다음: step2_저장소_생성');
}


/**
 * 2단계 — 드라이브 폴더와 구글 시트를 만듭니다.
 * 이미 만들어져 있으면 그대로 두고 링크만 알려줍니다.
 */
function step2_저장소_생성() {
  const props = PropertiesService.getScriptProperties();

  if (props.getProperty('SHEET_ID') && props.getProperty('PHOTO_FOLDER_ID')) {
    console.log('이미 만들어져 있습니다.');
    printStorageLinks_();
    return;
  }

  const root = getOrCreateFolder_(DriveApp.getRootFolder(), '독서노트');
  const photos = getOrCreateFolder_(root, '원본사진');

  const ss = SpreadsheetApp.create('독서 노트');
  DriveApp.getFileById(ss.getId()).moveTo(root);

  // 기본 시트를 '페이지'로 바꿔 쓰고, '노트'를 하나 더 만든다
  const first = ss.getSheets()[0].setName(PAGE_SHEET);
  writeHeaders_(first, PAGE_HEADERS);
  writeHeaders_(ss.insertSheet(NOTE_SHEET), NOTE_HEADERS);

  props.setProperty('SHEET_ID', ss.getId());
  props.setProperty('PHOTO_FOLDER_ID', photos.getId());

  console.log('생성 완료.');
  printStorageLinks_();
}

function getOrCreateFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function writeHeaders_(sheet, headers) {
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

function printStorageLinks_() {
  const props = PropertiesService.getScriptProperties();
  console.log('시트: https://docs.google.com/spreadsheets/d/' + props.getProperty('SHEET_ID'));
  console.log('사진 폴더: https://drive.google.com/drive/folders/' + props.getProperty('PHOTO_FOLDER_ID'));
}


/**
 * 3단계 — 메시지를 가져올 타이머를 겁니다. (배포 필요 없음)
 *
 * 웹훅 대신 폴링을 쓰는 이유는 Code.gs 의 poll() 주석 참고.
 * 이미 걸려 있던 웹훅이 있으면 해제합니다. 큐에 쌓인 메시지는 버리지 않고 그대로 받습니다.
 */
function step3_트리거_설치() {
  const before = tg_('getWebhookInfo', {});

  // v2(Cloudflare Worker)로 옮긴 뒤에는 이 함수를 쓰면 안 된다.
  // 웹훅을 지우고 폴링을 켜 버려서 봇이 통째로 v1 으로 되돌아간다.
  // 그러면 답장은 멀쩡히 오는데 저장은 시트로 가고 밑줄 앱에는 아무것도
  // 안 뜬다. 조용히 망가지는 모양이라 알아채기가 어렵다. 실제로 한 번 겪었다.
  if (before.url) {
    throw new Error(
      '웹훅이 이미 걸려 있습니다: ' + before.url + '\n' +
      'v2(Worker)가 이 봇을 받고 있다는 뜻입니다. 이 함수를 실행하면 v1 폴링으로\n' +
      '되돌아가서, 답장은 오지만 저장은 시트로 가고 앱에는 아무것도 안 뜹니다.\n' +
      '정말로 v1 으로 되돌릴 작정이면 이 검사를 지우고 실행하세요.');
  }

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'poll') ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('poll').timeBased().everyMinutes(POLL_MINUTES).create();
  console.log(POLL_MINUTES + '분마다 확인하도록 설정했습니다.');

  console.log('\n바로 한 번 확인해봅니다…');
  poll();
  console.log('완료. 밀려 있던 메시지가 있었다면 방금 처리됐습니다.');
}


/** 타이머 제거 — 봇을 멈추고 싶을 때 */
function 트리거_제거() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'poll') { ScriptApp.deleteTrigger(t); n++; }
  });
  console.log('트리거 ' + n + '개 제거. 이제 메시지를 받지 않습니다.');
}


/** 기다리기 답답할 때 지금 즉시 확인 */
function 지금_확인() {
  poll();
  console.log('확인 완료.');
}


/**
 * 4단계 — 내 텔레그램을 봇에 등록할 1회용 코드를 발급합니다.
 * 이 단계 전까지는 봇이 아무 메시지도 받지 않습니다.
 */
function step4_등록코드_발급() {
  const code = randomCode_();
  PropertiesService.getScriptProperties().setProperty('ENROLL_CODE', code);

  console.log('등록 코드: ' + code);
  console.log('\n텔레그램에서 봇 열기 → [시작] → 위 코드를 그대로 입력하면 등록됩니다.');
  console.log('(코드는 한 번 쓰이면 자동 폐기됩니다)');
}


/** 앱(book-notes)을 배포한 뒤, 봇 답장에 링크를 띄우고 싶을 때 */
function 앱주소_등록() {
  const url = ''; // ← 여기에 book-notes 웹앱 /exec 주소를 넣고 실행
  if (!/^https:\/\//.test(url)) throw new Error('함수 안 url 변수에 앱 주소를 넣으세요.');
  PropertiesService.getScriptProperties().setProperty('APP_URL', url);
  console.log('앱 주소 저장 완료: ' + url);
}


/** 내 봇 주소 확인 */
function 봇주소_확인() {
  const me = tg_('getMe', {});
  console.log('사용자명: @' + me.username);
  console.log('https://t.me/' + me.username);
}


/** 현재 상태 점검 */
function 상태확인() {
  const props = PropertiesService.getScriptProperties().getProperties();

  ['TELEGRAM_TOKEN', 'GEMINI_API_KEY', 'SHEET_ID', 'PHOTO_FOLDER_ID']
    .forEach(function (k) {
      const v = props[k];
      console.log(k + ': ' + (v ? '설정됨 (' + v.slice(0, 6) + '…)' : '❌ 비어 있음'));
    });

  const ids = (props.ALLOWED_CHAT_IDS || '').split(',').filter(String);
  console.log('ALLOWED_CHAT_IDS: ' + (ids.length ? ids.join(', ') : '❌ 비어 있음 (아무도 못 씀)'));
  console.log('ENROLL_CODE: ' + (props.ENROLL_CODE || '없음'));
  console.log('현재_책: ' + (props['현재_책'] || '미설정'));
  console.log('APP_URL: ' + (props.APP_URL || '미설정'));

  if (props.SHEET_ID) {
    printStorageLinks_();
    const sheet = sheet_(PAGE_SHEET);
    console.log('저장된 페이지 수: ' + Math.max(0, sheet.getLastRow() - 1));
  }

  const triggers = ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'poll'; });
  console.log('수신 트리거: ' + (triggers.length ? triggers.length + '개 작동 중'
                                                  : '❌ 없음 (step3_트리거_설치 실행 필요)'));
  console.log('마지막 처리 지점(UPDATE_OFFSET): ' + (props.UPDATE_OFFSET || '0'));

  try {
    const hook = tg_('getWebhookInfo', {});
    console.log('웹훅: ' + (hook.url ? '⚠️ 아직 걸려 있음 — step3_트리거_설치 를 실행하세요'
                                     : '해제됨 (정상)'));
  } catch (err) {
    console.log('텔레그램 조회 실패: ' + err);
  }
}


function 허용목록_보기() {
  const props = PropertiesService.getScriptProperties();
  const ids = (props.getProperty('ALLOWED_CHAT_IDS') || '').split(',').filter(String);
  console.log(ids.length ? '허용된 챗 ID: ' + ids.join(', ')
                         : '허용된 사용자 없음. step4_등록코드_발급 을 실행하세요.');
}


function 허용목록_직접추가() {
  const id = String(CHAT_ID_TO_ADD || '').trim();
  if (!/^-?\d+$/.test(id)) throw new Error('CHAT_ID_TO_ADD 에 숫자 챗 ID를 넣으세요.');

  const props = PropertiesService.getScriptProperties();
  const ids = (props.getProperty('ALLOWED_CHAT_IDS') || '').split(',')
    .map(function (s) { return s.trim(); }).filter(Boolean);

  if (ids.indexOf(id) !== -1) { console.log('이미 허용되어 있습니다.'); return; }
  ids.push(id);
  props.setProperty('ALLOWED_CHAT_IDS', ids.join(','));
  console.log('추가 완료: ' + ids.join(', '));
}


function 허용목록_비우기() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('ALLOWED_CHAT_IDS');
  props.deleteProperty('ENROLL_CODE');
  console.log('허용 목록을 비웠습니다.');
}


function 웹훅_강제해제() {
  console.log('해제: ' + tg_('deleteWebhook', { drop_pending_updates: true }));
}


/** 헷갈리는 글자(I, O, 0, 1)를 뺀 8자리 코드 */
function randomCode_() {
  const hex = Utilities.getUuid().replace(/-/g, '').toUpperCase();
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += alphabet.charAt(parseInt(hex.substr(i * 2, 2), 16) % alphabet.length);
  }
  return out.slice(0, 4) + '-' + out.slice(4);
}


/**
 * 진단용 — 드라이브에 저장된 가장 최근 사진으로 Gemini 를 다시 불러
 * 응답을 가공 없이 그대로 찍어봅니다. "글자를 읽어내지 못했습니다" 가 뜰 때 쓰세요.
 */
function 마지막사진_파싱테스트() {
  const folder = DriveApp.getFolderById(prop_('PHOTO_FOLDER_ID'));
  const files = folder.getFiles();

  let newest = null;
  while (files.hasNext()) {
    const f = files.next();
    if (!newest || f.getDateCreated() > newest.getDateCreated()) newest = f;
  }
  if (!newest) throw new Error('원본사진 폴더가 비어 있습니다. 사진을 먼저 보내주세요.');

  console.log('대상 파일: ' + newest.getName() +
              ' (' + Math.round(newest.getSize() / 1024) + 'KB, ' + newest.getMimeType() + ')');
  console.log('모델: ' + GEMINI_MODEL);
  console.log('─'.repeat(50));

  const r = callGemini_(newest.getBlob());

  console.log('HTTP ' + r.code);
  console.log('finishReason: ' + (r.cand.finishReason || '(없음)'));
  console.log('promptFeedback: ' + JSON.stringify(r.body.promptFeedback || {}));
  console.log('usage: ' + JSON.stringify(r.body.usageMetadata || {}));
  console.log('조각 수: ' + ((((r.cand.content || {}).parts) || []).length));
  console.log('─'.repeat(50));
  console.log('본문 응답:');
  console.log(r.text || '(비어 있음)');
  console.log('─'.repeat(50));
  console.log('전체 응답(앞 2000자):');
  console.log(JSON.stringify(r.body).slice(0, 2000));
}


// ═══════════════ v2 이전 (Cloudflare) ═══════════════

/** 배포한 Worker 주소와 ADMIN_SECRET. 이전할 때만 채웁니다. */
const WORKER_URL = '';
const ADMIN_SECRET = '';

/**
 * 시트에 쌓인 것을 D1 으로 한 번에 옮깁니다. 여러 번 실행해도 안전합니다
 * (같은 id 는 덮어씁니다).
 *
 * 옮기고 나면 반드시 `트리거_제거` 로 이 봇을 멈추세요.
 * 텔레그램은 봇 하나에 웹훅과 getUpdates 를 동시에 허용하지 않습니다.
 */
function v2_D1로_이전() {
  if (!/^https:\/\//.test(WORKER_URL)) throw new Error('WORKER_URL 을 채우세요.');
  if (!ADMIN_SECRET) throw new Error('ADMIN_SECRET 을 채우세요.');

  const pages = rows_(PAGE_SHEET).map(function (r) {
    return {
      id: String(r[0]),
      book: String(r[1]),
      page: r[2] === '' ? null : Number(r[2]),
      shot_at: toIso_(r[3]),
      sentences: parseJson_(r[4]),
      starts_mid: String(r[5]).toUpperCase() === 'TRUE',
      ends_mid: String(r[6]).toUpperCase() === 'TRUE',
      prev_id: String(r[7]) || null,
      photo_id: String(r[8]) || null
    };
  }).filter(function (p) { return p.id; });

  const notes = rows_(NOTE_SHEET).map(function (r) {
    return {
      id: String(r[0]),
      page_id: String(r[1]),
      book: String(r[2]),
      page: r[3] === '' ? null : Number(r[3]),
      text: String(r[4]),
      idx: Number(r[5]),
      saved_at: toIso_(r[7])
    };
  }).filter(function (n) { return n.id && n.page_id; });

  const res = UrlFetchApp.fetch(WORKER_URL.replace(/\/$/, '') + '/admin/import', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ secret: ADMIN_SECRET, pages: pages, notes: notes }),
    muteHttpExceptions: true
  });

  console.log('HTTP ' + res.getResponseCode());
  console.log(res.getContentText());
  console.log('\n보낸 것: 페이지 ' + pages.length + '건, 노트 ' + notes.length + '건');
  console.log('성공했으면 이제 `트리거_제거` 로 v1 봇을 멈추세요.');
}

function rows_(name) {
  const values = sheet_(name).getDataRange().getValues();
  return values.length > 1 ? values.slice(1) : [];
}

function parseJson_(v) {
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a : [];
  } catch (err) { return []; }
}

/** 시트의 "2026-09-19 01:30:00" 을 ISO 로. 정렬 기준이라 형식이 맞아야 한다. */
function toIso_(v) {
  const d = (v instanceof Date) ? v : new Date(String(v).replace(' ', 'T') + '+09:00');
  return isNaN(d) ? new Date().toISOString() : d.toISOString();
}


/** 지금 쓸 수 있는 Gemini 모델 목록 — 호출이 404가 나면 여기서 이름을 확인하세요 */
function 모델_확인() {
  const res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' +
    encodeURIComponent(prop_('GEMINI_API_KEY')), { muteHttpExceptions: true });

  if (res.getResponseCode() >= 300) {
    throw new Error('모델 목록 조회 실패 (HTTP ' + res.getResponseCode() + '): ' +
                    res.getContentText().slice(0, 300));
  }

  const models = (JSON.parse(res.getContentText()).models || []).filter(function (m) {
    return (m.supportedGenerationMethods || []).indexOf('generateContent') !== -1;
  });

  console.log('지금 쓰는 모델: ' + GEMINI_MODEL);
  console.log('사용 가능한 모델 ' + models.length + '개:');
  models.forEach(function (m) { console.log('  ' + m.name.replace('models/', '')); });
  console.log('\nCode.gs 의 GEMINI_MODEL 을 위 이름 중 하나로 바꾸면 됩니다.');
}
