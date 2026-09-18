/**
 * 독서 노트 봇 — 책 페이지 사진을 문장 단위로 파싱해 시트에 쌓는다.
 *
 *   텔레그램(사진) → Apps Script → Gemini(문장 파싱) → 구글 시트 + 드라이브
 *
 * 설계 배경은 ../설계.md, 설치 순서는 ../README.md 참고.
 * 하이라이트를 고르는 앱은 별도 프로젝트(book-notes)다.
 */

// ───────────────────────────── 설정 ─────────────────────────────

const GEMINI_MODEL = 'gemini-3.6-flash';

/** 쪽번호가 없을 때, 직전 사진과 이 시간 안이면 같은 흐름으로 본다 */
const STITCH_WINDOW_MS = 10 * 60 * 1000;

const PAGE_SHEET = '페이지';
const NOTE_SHEET = '노트';

const PAGE_HEADERS = ['page_id', '책', '쪽', '촬영일시', '문장들',
                      '앞에서_이어짐', '뒤로_이어짐', '이전_page_id', '사진_id', '원문'];
const NOTE_HEADERS = ['note_id', 'page_id', '책', '쪽', '문장', '문장_index', '메모', '저장일시'];

/** 명함봇과 달리 키를 영문으로 둔다 — 코드에서 다루기 쉽다 */
const PAGE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    page_number: {
      type: 'INTEGER',
      nullable: true,
      description: '페이지에 인쇄된 쪽번호. 없으면 null. 양면이면 오른쪽(나중) 쪽번호.'
    },
    sentences: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: '본문을 문장 단위로 쪼갠 배열.'
    },
    starts_mid_sentence: {
      type: 'BOOLEAN',
      description: '첫 문장이 앞 페이지에서 이어지는 조각인가.'
    },
    ends_mid_sentence: {
      type: 'BOOLEAN',
      description: '마지막 문장이 끝나지 않고 다음 페이지로 이어지는가.'
    }
  },
  propertyOrdering: ['page_number', 'sentences', 'starts_mid_sentence', 'ends_mid_sentence'],
  required: ['sentences', 'starts_mid_sentence', 'ends_mid_sentence']
};

const PAGE_PROMPT = [
  '이 이미지는 책의 한 페이지(또는 펼친 양면)입니다. 본문을 그대로 옮겨 JSON으로만 답하세요.',
  '',
  '규칙:',
  '- 본문만 담으세요. 쪽번호, 각주 번호, 머리말(러닝헤드), 챕터 제목, 출판사 정보는 문장에서 빼세요.',
  '- 본문을 문장 단위로 쪼개 sentences 배열에 넣으세요. 대화문의 따옴표는 그대로 둡니다.',
  '- 문단이 바뀌어도 배열 원소를 나누기만 하고 빈 원소는 넣지 마세요.',
  '- 페이지가 문장 도중에 끝나면, 그 조각을 있는 그대로 마지막 원소로 두고',
  '  ends_mid_sentence 를 true 로 하세요. 임의로 문장을 완성하지 마세요.',
  '- 첫 문장이 앞 페이지에서 이어지는 조각이면 starts_mid_sentence 를 true 로 하세요.',
  '  (문장 첫머리가 아니라 중간부터 시작하는 경우)',
  '- 펼친 양면이면 왼쪽 페이지를 먼저, 오른쪽 페이지를 나중에 읽으세요.',
  '- 글자를 알아볼 수 없으면 지어내지 말고 그 자리에 ▯ 를 쓰세요.',
  '- 쪽번호를 찾을 수 없으면 page_number 를 null 로 두세요.',
  '- 책 페이지가 아니면 sentences 를 빈 배열로 두세요.'
].join('\n');

// ──────────────────────── 메시지 수신 (폴링) ────────────────────────

/**
 * 1분마다 트리거가 부르는 진입점. 텔레그램에 "새 메시지 있냐"고 물어서 처리한다.
 *
 * 웹훅을 쓰지 않는 이유: Apps Script 웹앱은 /exec 요청에 항상 302 리디렉션을 돌려주는데
 * 텔레그램은 리디렉션을 따라가지 않고 실패로 간주한다. 실패한 업데이트를 재시도하는 동안
 * 뒤에 온 메시지가 큐에 막혀 영영 전달되지 않는다. 폴링에는 그 문제가 없다.
 *
 * 함수 이름에 밑줄을 붙이지 않는다 — Apps Script 트리거는 비공개 함수를 부르지 못한다.
 */
function poll() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // 앞 실행이 아직 도는 중

  try {
    const props = PropertiesService.getScriptProperties();
    let offset = Number(props.getProperty('UPDATE_OFFSET') || 0);

    for (let round = 0; round < 5; round++) {
      const updates = tg_('getUpdates', {
        offset: offset,
        timeout: 0,
        limit: 10,
        allowed_updates: ['message']
      });
      if (!updates.length) break;

      for (let i = 0; i < updates.length; i++) {
        const u = updates[i];

        // 먼저 확인 처리부터 한다. 처리 중 죽어도 같은 메시지를 무한히 되풀이하지 않도록.
        offset = Math.max(offset, u.update_id + 1);
        props.setProperty('UPDATE_OFFSET', String(offset));

        if (!firstTime_(u.update_id)) continue;

        try {
          handleUpdate_(u);
        } catch (err) {
          console.error('update ' + u.update_id + ' 처리 실패: ' + (err.stack || err));
        }
      }
    }

    // 지난번에 Gemini가 붐벼서 못 끝낸 사진이 있으면 여기서 다시 해본다
    try {
      retryPending_();
    } catch (err) {
      console.error('재시도 실패: ' + (err.stack || err));
    }
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

function handleUpdate_(update) {
  const msg = update.message || update.channel_post;
  if (!msg || !msg.chat) return;

  const chatId = msg.chat.id;

  if (!isAllowed_(chatId)) {
    if (tryEnroll_(chatId, msg.text)) {
      reply_(chatId, '✅ 등록되었습니다.\n\n<b>/책 데미안</b> 처럼 읽는 책을 정한 뒤 페이지 사진을 보내주세요.');
    } else {
      console.warn('미승인 접근: chat_id=' + chatId +
                   ' username=@' + ((msg.from && msg.from.username) || '?'));
      reply_(chatId, '이 봇은 지정된 사용자만 사용할 수 있습니다.\n' +
                     '등록 코드가 있다면 그 코드만 그대로 보내주세요.');
    }
    return;
  }

  const text = trim_(msg.text);

  if (text.indexOf('/책') === 0) { cmdBook_(chatId, text.slice(2)); return; }
  if (text.indexOf('/앱') === 0) { cmdApp_(chatId); return; }
  if (text.indexOf('/start') === 0) { cmdHelp_(chatId); return; }

  const fileId = pickImageFileId_(msg);
  if (fileId) { processPhoto_(chatId, fileId); return; }

  if (text) cmdHelp_(chatId);
}

// ──────────────────────── 명령 ────────────────────────

function cmdBook_(chatId, rest) {
  const name = trim_(rest);
  const props = PropertiesService.getScriptProperties();

  if (!name) {
    const now = props.getProperty('현재_책');
    reply_(chatId, now ? '지금 읽는 책: <b>' + esc_(now) + '</b>'
                       : '아직 책을 정하지 않았습니다.\n<b>/책 데미안</b> 처럼 보내주세요.');
    return;
  }

  props.setProperty('현재_책', name);
  reply_(chatId, '📖 <b>' + esc_(name) + '</b>' + josaRo_(name) + ' 설정했습니다.\n이제 페이지 사진을 보내주세요.');
}

/** 받침에 따라 '으로' / '로' — "데미안으로", "AI리터러시로" */
function josaRo_(word) {
  const last = String(word).trim().slice(-1);
  const code = last.charCodeAt(0) - 0xAC00;
  if (code < 0 || code > 11171) return '으로';        // 한글이 아니면 무난한 쪽
  const jong = code % 28;
  return (jong === 0 || jong === 8) ? '로' : '으로';  // 받침 없음, 또는 ㄹ받침
}

function cmdApp_(chatId) {
  const url = PropertiesService.getScriptProperties().getProperty('APP_URL');
  reply_(chatId, url ? '<a href="' + url + '">독서 노트 열기</a>'
                     : '앱이 아직 배포되지 않았습니다.');
}

function cmdHelp_(chatId) {
  reply_(chatId, [
    '📖 <b>독서 노트 봇</b>',
    '',
    '<b>/책 데미안</b> — 읽는 책 정하기',
    '<b>/책</b> — 지금 무슨 책인지',
    '<b>/앱</b> — 독서 노트 열기',
    '',
    '책을 정한 뒤 페이지 사진을 보내면 문장 단위로 저장합니다.',
    '펼친 양면으로 찍으면 문장이 잘리지 않아 더 깔끔합니다.'
  ].join('\n'));
}

// ──────────────────────── 사진 처리 ────────────────────────

function processPhoto_(chatId, fileId) {
  const book = PropertiesService.getScriptProperties().getProperty('현재_책');
  if (!book) {
    reply_(chatId, '먼저 책을 정해주세요.\n<b>/책 데미안</b> 처럼 보내시면 됩니다.');
    return;
  }

  let photoId;
  try {
    tg_('sendChatAction', { chat_id: chatId, action: 'typing' });
    const blob = downloadTelegramFile_(fileId);
    // 파싱보다 먼저 저장한다. 파싱이 실패해도 원본은 남아야 다시 시도할 수 있다.
    photoId = savePhotoToDrive_(blob, book, null, new Date());
  } catch (err) {
    console.error(err.stack || String(err));
    reply_(chatId, '⚠️ 사진을 가져오지 못했습니다.\n\n<code>' +
                   esc_(String(err.message || err)).slice(0, 500) + '</code>');
    return;
  }

  parseAndStore_(chatId, book, photoId, 0);
}

/**
 * 저장된 사진 한 장을 파싱해 시트에 넣는다.
 * Gemini 가 붐벼서 실패하면(503 등) 대기열에 올려 다음 폴링 때 자동으로 다시 시도한다.
 */
function parseAndStore_(chatId, book, photoId, tries) {
  let parsed;
  try {
    parsed = parsePageWithGemini_(DriveApp.getFileById(photoId).getBlob());
  } catch (err) {
    console.error(err.stack || String(err));
    queueRetry_(chatId, book, photoId, tries, String(err.message || err));
    return;
  }

  clearRetry_();

  if (!parsed.sentences.length) {
    reply_(chatId, '글자를 읽어내지 못했습니다. 밝은 곳에서 페이지가 평평하게 펴지도록 다시 찍어주세요. 📷\n' +
                   '<i>(원본은 드라이브에 저장돼 있습니다. <b>마지막사진_파싱테스트</b> 로 원인을 볼 수 있습니다)</i>');
    return;
  }

  const now = new Date();
  const prev = findPreviousPage_(book);
  const stitched = shouldStitch_(prev, parsed, now);

  // 쪽번호를 알았으니 파일 이름도 맞춰준다 (폴더에서 찾기 쉽게)
  if (parsed.page_number) {
    try {
      DriveApp.getFileById(photoId)
        .setName(safeName_(book) + '_' + parsed.page_number + '쪽_' +
                 Utilities.formatDate(now, 'Asia/Seoul', 'yyyyMMdd_HHmmss') + '.jpg');
    } catch (ignored) {}
  }

  const page = appendPageRow_({
    book: book,
    pageNumber: parsed.page_number,
    when: now,
    sentences: parsed.sentences,
    startsMid: !!parsed.starts_mid_sentence,
    endsMid: !!parsed.ends_mid_sentence,
    prevPageId: stitched ? prev.page_id : '',
    photoId: photoId
  });

  reply_(chatId, buildReply_(book, parsed, page, stitched ? prev : null));
}

// ──────────────────────── 자동 재시도 ────────────────────────

/** Gemini 과부하는 흔하고 대개 몇 분이면 풀린다. 사람이 다시 보내게 하지 않는다. */
const MAX_RETRY = 6;

function queueRetry_(chatId, book, photoId, tries, message) {
  const props = PropertiesService.getScriptProperties();
  const next = tries + 1;

  if (next >= MAX_RETRY) {
    props.deleteProperty('PENDING_PHOTO');
    reply_(chatId, '⚠️ ' + MAX_RETRY + '번 시도했지만 실패했습니다.\n\n<code>' +
                   esc_(message).slice(0, 500) + '</code>\n\n' +
                   '<i>원본은 드라이브에 있습니다. 나중에 다시 보내보세요.</i>');
    return;
  }

  props.setProperty('PENDING_PHOTO', JSON.stringify({
    chatId: chatId, book: book, photoId: photoId, tries: next
  }));

  if (tries === 0) {
    reply_(chatId, '⏳ Gemini가 잠시 붐빕니다. 다시 보내실 필요 없습니다 — 1분 뒤 자동으로 재시도합니다.');
  }
}

function clearRetry_() {
  PropertiesService.getScriptProperties().deleteProperty('PENDING_PHOTO');
}

/** 폴링 때마다 한 번씩 불린다 */
function retryPending_() {
  const raw = PropertiesService.getScriptProperties().getProperty('PENDING_PHOTO');
  if (!raw) return;

  const p = JSON.parse(raw);
  console.log('재시도 ' + p.tries + '/' + MAX_RETRY + ' — ' + p.photoId);
  parseAndStore_(p.chatId, p.book, p.photoId, p.tries);
}

function safeName_(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '_');
}

function pickImageFileId_(msg) {
  if (msg.photo && msg.photo.length) return msg.photo[msg.photo.length - 1].file_id;
  if (msg.document && /^image\//.test(msg.document.mime_type || '')) return msg.document.file_id;
  return null;
}

function buildReply_(book, parsed, page, prev) {
  const head = '📖 <b>' + esc_(book) + '</b>' +
               (parsed.page_number ? ' ' + parsed.page_number + '쪽' : '') +
               ' · 문장 ' + parsed.sentences.length + '개';

  const lines = [head, ''];
  parsed.sentences.forEach(function (s, i) {
    lines.push((i + 1) + '. ' + esc_(s));
  });

  if (prev) {
    lines.push('', '⟩ ' + (prev['쪽'] ? prev['쪽'] + '쪽' : '앞 페이지') + ' 마지막 문장과 이어붙였습니다');
  } else if (parsed.ends_mid_sentence) {
    lines.push('', '⟩ 마지막 문장이 다음 페이지로 이어집니다');
  }

  const appUrl = PropertiesService.getScriptProperties().getProperty('APP_URL');
  if (appUrl) lines.push('', '<a href="' + appUrl + '">앱에서 열기</a>');

  let out = lines.join('\n');
  if (out.length > 4000) out = out.slice(0, 3900) + '\n\n… (길어서 줄임 — 앱에서 전체 확인)';
  return out;
}

// ──────────────────────── 이어붙이기 판정 ────────────────────────

/** 같은 책의 가장 최근 페이지 한 건 */
function findPreviousPage_(book) {
  const sheet = sheet_(PAGE_SHEET);
  const last = sheet.getLastRow();
  if (last < 2) return null;

  const from = Math.max(2, last - 99); // 최근 100건이면 충분하다
  const rows = sheet.getRange(from, 1, last - from + 1, PAGE_HEADERS.length).getValues();

  for (let i = rows.length - 1; i >= 0; i--) {
    const r = toPage_(rows[i]);
    if (r['책'] === book) return r;
  }
  return null;
}

function shouldStitch_(prev, parsed, now) {
  if (!prev) return false;
  if (String(prev['뒤로_이어짐']).toUpperCase() !== 'TRUE') return false;
  if (!parsed.starts_mid_sentence) return false;

  // 쪽번호를 둘 다 읽었으면 연속일 때만 — 가장 확실한 근거
  if (prev['쪽'] && parsed.page_number) {
    return Number(parsed.page_number) === Number(prev['쪽']) + 1;
  }

  // 쪽번호가 없으면 직전 촬영과 가까운지로 판단
  const prevTime = new Date(prev['촬영일시']).getTime();
  return isFinite(prevTime) && (now.getTime() - prevTime) <= STITCH_WINDOW_MS;
}

// ──────────────────────── 저장 ────────────────────────

function savePhotoToDrive_(blob, book, pageNumber, when) {
  const folder = DriveApp.getFolderById(prop_('PHOTO_FOLDER_ID'));
  const name = [
    book.replace(/[\\/:*?"<>|]/g, '_'),
    pageNumber ? pageNumber + '쪽' : '쪽미상',
    Utilities.formatDate(when, 'Asia/Seoul', 'yyyyMMdd_HHmmss')
  ].join('_') + '.jpg';

  return folder.createFile(blob.setName(name)).getId();
}

function appendPageRow_(p) {
  const sheet = sheet_(PAGE_SHEET);
  const pageId = nextId_('p');

  sheet.appendRow([
    pageId,
    p.book,
    p.pageNumber || '',
    Utilities.formatDate(p.when, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss'),
    JSON.stringify(p.sentences),
    p.startsMid ? 'TRUE' : 'FALSE',
    p.endsMid ? 'TRUE' : 'FALSE',
    p.prevPageId || '',
    p.photoId,
    p.sentences.join(' ')
  ]);

  return { page_id: pageId };
}

function toPage_(row) {
  const o = {};
  PAGE_HEADERS.forEach(function (h, i) { o[h] = row[i]; });
  return o;
}

function sheet_(name) {
  const ss = SpreadsheetApp.openById(prop_('SHEET_ID'));
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('시트 탭을 찾을 수 없습니다: ' + name + ' (step2_저장소_생성 실행 여부 확인)');
  return sheet;
}

/** p_20260919_0031 형태의 순번 ID */
function nextId_(prefix) {
  const props = PropertiesService.getScriptProperties();
  const key = 'SEQ_' + prefix;
  const lock = LockService.getScriptLock();
  let n;
  try {
    lock.waitLock(10000);
    n = Number(props.getProperty(key) || 0) + 1;
    props.setProperty(key, String(n));
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
  return prefix + '_' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd') +
         '_' + ('0000' + n).slice(-4);
}

// ──────────────────────── Gemini ────────────────────────

/** Gemini 를 부르고 {code, body, text} 를 그대로 돌려준다 — 진단용으로도 쓴다 */
function callGemini_(blob) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL +
              ':generateContent?key=' + encodeURIComponent(prop_('GEMINI_API_KEY'));

  const payload = {
    contents: [{
      role: 'user',
      parts: [
        {
          inline_data: {
            mime_type: blob.getContentType() || 'image/jpeg',
            data: Utilities.base64Encode(blob.getBytes())
          }
        },
        { text: PAGE_PROMPT }
      ]
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: PAGE_SCHEMA
      // 문장 경계와 이어짐 판정에는 추론이 도움이 되므로 thinking 을 끄지 않는다
    }
  };

  const res = fetchWithRetry_(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() >= 300) {
    throw new Error('Gemini 호출 실패 (HTTP ' + res.getResponseCode() + '): ' +
                    res.getContentText().slice(0, 500));
  }

  const body = JSON.parse(res.getContentText());
  const cand = (body.candidates && body.candidates[0]) || {};

  // Gemini 3 계열은 응답을 여러 조각으로 나눠 보내고, 그중 thought 조각은 결과가 아니다.
  // parts[0] 만 보면 빈손으로 돌아오는 경우가 생긴다.
  const text = (((cand.content || {}).parts) || [])
    .filter(function (p) { return p && typeof p.text === 'string' && !p.thought; })
    .map(function (p) { return p.text; })
    .join('');

  return { code: res.getResponseCode(), body: body, text: text, cand: cand };
}

function parsePageWithGemini_(blob) {
  const r = callGemini_(blob);

  if (!r.text) {
    throw new Error('Gemini 응답이 비었습니다. finishReason=' + (r.cand.finishReason || '?') +
                    ' / ' + JSON.stringify(r.body).slice(0, 600));
  }

  let parsed;
  try {
    parsed = JSON.parse(r.text);
  } catch (err) {
    throw new Error('Gemini가 JSON이 아닌 답을 줬습니다: ' + r.text.slice(0, 400));
  }

  parsed.sentences = (parsed.sentences || [])
    .map(function (s) { return trim_(s); })
    .filter(Boolean);

  // 왜 빈손인지 나중에 알 수 있도록 원문을 남긴다
  if (!parsed.sentences.length) {
    console.warn('문장 0개로 돌아옴. finishReason=' + (r.cand.finishReason || '?') +
                 ' / Gemini 원문: ' + r.text.slice(0, 1500) +
                 ' / promptFeedback: ' + JSON.stringify(r.body.promptFeedback || {}));
  }

  return parsed;
}

function fetchWithRetry_(url, options) {
  const waits = [2000, 5000, 12000];  // 503(과부하)은 몇 초로는 잘 안 풀린다
  let res;
  for (let i = 0; i <= waits.length; i++) {
    res = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();
    if (code !== 429 && code < 500) return res;
    if (i < waits.length) Utilities.sleep(waits[i]);
  }
  return res;
}

// ──────────────────────── 텔레그램 ────────────────────────

function tg_(method, payload) {
  const res = UrlFetchApp.fetch(
    'https://api.telegram.org/bot' + prop_('TELEGRAM_TOKEN') + '/' + method,
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    }
  );
  const body = JSON.parse(res.getContentText());
  if (!body.ok) throw new Error('텔레그램 ' + method + ' 실패: ' + res.getContentText());
  return body.result;
}

function reply_(chatId, html) {
  try {
    tg_('sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
  } catch (err) {
    console.error('답장 실패: ' + err);
  }
}

function downloadTelegramFile_(fileId) {
  const file = tg_('getFile', { file_id: fileId });
  const res = UrlFetchApp.fetch(
    'https://api.telegram.org/file/bot' + prop_('TELEGRAM_TOKEN') + '/' + file.file_path,
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) {
    throw new Error('사진 다운로드 실패 (HTTP ' + res.getResponseCode() + ')');
  }
  return res.getBlob();
}

// ──────────────────────── 사용자 허용 목록 ────────────────────────

function allowedChatIds_() {
  const raw = PropertiesService.getScriptProperties().getProperty('ALLOWED_CHAT_IDS') || '';
  return raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function isAllowed_(chatId) {
  return allowedChatIds_().indexOf(String(chatId)) !== -1;
}

function tryEnroll_(chatId, text) {
  const props = PropertiesService.getScriptProperties();
  const code = props.getProperty('ENROLL_CODE') || '';
  if (normCode_(code).length < 6 || normCode_(text) !== normCode_(code)) return false;

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    if (normCode_(props.getProperty('ENROLL_CODE')) !== normCode_(code)) return false;

    const ids = allowedChatIds_();
    ids.push(String(chatId));
    props.setProperty('ALLOWED_CHAT_IDS', ids.join(','));
    props.deleteProperty('ENROLL_CODE');
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }

  console.log('허용 목록에 추가됨: chat_id=' + chatId);
  return true;
}

// ──────────────────────── 잡동사니 ────────────────────────

function prop_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('스크립트 속성이 비어 있습니다: ' + key);
  return v;
}

function firstTime_(updateId) {
  if (!updateId) return true;
  const cache = CacheService.getScriptCache();
  const key = 'seen_' + updateId;
  if (cache.get(key)) return false;
  cache.put(key, '1', 600);
  return true;
}

function trim_(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function normCode_(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
