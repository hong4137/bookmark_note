/**
 * 독서 노트 앱 — 쌓인 페이지에서 문장을 골라 노트로 남긴다.
 *
 * 봇(book-bot)과 같은 시트·드라이브 폴더를 쓰지만 프로젝트는 따로 둔다.
 * Apps Script 웹앱은 배포 하나당 접근 권한이 하나뿐이라, 봇 웹훅(공개)과
 * 이 앱(나만)을 한 프로젝트에 둘 수 없다. 자세한 배경은 ../설계.md 참고.
 */

const PAGE_SHEET = '페이지';
const NOTE_SHEET = '노트';

// 시트 컬럼 위치 (봇이 쓰는 순서와 같아야 한다)
const P = { id: 0, book: 1, page: 2, when: 3, sentences: 4,
            startsMid: 5, endsMid: 6, prevId: 7, photo: 8, raw: 9 };
const N = { id: 0, pageId: 1, book: 2, page: 3, text: 4, index: 5, memo: 6, when: 7 };

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('독서 노트')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

// ──────────────────────── 화면이 부르는 함수들 ────────────────────────

/** 책 목록 — 최근에 찍은 책이 위로 */
function api_books() {
  const pages = rows_(PAGE_SHEET);
  const notes = rows_(NOTE_SHEET);

  const byBook = {};
  pages.forEach(function (r) {
    const b = String(r[P.book]);
    if (!byBook[b]) byBook[b] = { book: b, pages: 0, notes: 0, last: '' };
    byBook[b].pages++;
    const w = String(r[P.when]);
    if (w > byBook[b].last) byBook[b].last = w;
  });

  notes.forEach(function (r) {
    const b = String(r[N.book]);
    if (byBook[b]) byBook[b].notes++;
  });

  return Object.keys(byBook)
    .map(function (k) { return byBook[k]; })
    .sort(function (a, b) { return a.last < b.last ? 1 : -1; });
}

/** 한 책의 페이지 목록 — 최근 것이 위로 */
function api_pages(book) {
  const noteCount = {};
  rows_(NOTE_SHEET).forEach(function (r) {
    const k = String(r[N.pageId]);
    noteCount[k] = (noteCount[k] || 0) + 1;
  });

  return rows_(PAGE_SHEET)
    .filter(function (r) { return String(r[P.book]) === book; })
    .map(function (r) {
      const sentences = parseSentences_(r[P.sentences]);
      return {
        id: String(r[P.id]),
        page: r[P.page] === '' ? null : Number(r[P.page]),
        when: String(r[P.when]),
        count: sentences.length,
        notes: noteCount[String(r[P.id])] || 0,
        preview: sentences.length ? sentences[0].slice(0, 60) : '(빈 페이지)',
        stitched: !!String(r[P.prevId])
      };
    })
    .sort(function (a, b) { return a.when < b.when ? 1 : -1; });
}

/** 페이지 하나 — 문장 목록과 하이라이트 상태 */
function api_page(pageId) {
  const row = findPage_(pageId);
  if (!row) throw new Error('페이지를 찾을 수 없습니다: ' + pageId);

  const sentences = parseSentences_(row[P.sentences]);
  const marked = {};
  rows_(NOTE_SHEET).forEach(function (r) {
    if (String(r[N.pageId]) === pageId) marked[Number(r[N.index])] = String(r[N.text]);
  });

  // 앞 페이지와 이어진 문장이면, 앞 조각을 붙여서 보여준다 (원본은 그대로 둔다)
  let prevTail = '';
  let prevPage = null;
  const prevId = String(row[P.prevId]);
  if (prevId) {
    const prev = findPage_(prevId);
    if (prev) {
      const ps = parseSentences_(prev[P.sentences]);
      if (ps.length) prevTail = ps[ps.length - 1];
      prevPage = prev[P.page] === '' ? null : Number(prev[P.page]);
    }
  }

  return {
    id: pageId,
    book: String(row[P.book]),
    page: row[P.page] === '' ? null : Number(row[P.page]),
    when: String(row[P.when]),
    endsMid: String(row[P.endsMid]).toUpperCase() === 'TRUE',
    prevTail: prevTail,
    prevPage: prevPage,
    canStitch: !prevId && String(row[P.startsMid]).toUpperCase() === 'TRUE',
    sentences: sentences.map(function (s, i) {
      return { i: i, text: s, on: i in marked };
    })
  };
}

/** 문장 하나를 노트에 넣거나 뺀다 */
function api_toggle(pageId, index, text) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = sheet_(NOTE_SHEET);
    const all = sheet.getDataRange().getValues();

    for (let i = all.length - 1; i >= 1; i--) {
      if (String(all[i][N.pageId]) === pageId && Number(all[i][N.index]) === index) {
        sheet.deleteRow(i + 1);
        return { on: false };
      }
    }

    const page = findPage_(pageId);
    sheet.appendRow([
      nextId_('n'),
      pageId,
      String(page[P.book]),
      page[P.page],
      text,
      index,
      '',
      Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss')
    ]);
    return { on: true };
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

/** 파싱이 틀렸을 때 문장을 고친다 */
function api_edit(pageId, index, text) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('빈 문장으로는 바꿀 수 없습니다.');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = sheet_(PAGE_SHEET);
    const all = sheet.getDataRange().getValues();

    for (let i = 1; i < all.length; i++) {
      if (String(all[i][P.id]) !== pageId) continue;

      const sentences = parseSentences_(all[i][P.sentences]);
      if (index < 0 || index >= sentences.length) throw new Error('없는 문장입니다.');
      sentences[index] = clean;

      sheet.getRange(i + 1, P.sentences + 1).setValue(JSON.stringify(sentences));
      sheet.getRange(i + 1, P.raw + 1).setValue(sentences.join(' '));
      break;
    }

    // 이미 노트에 담긴 문장이면 노트 쪽도 같이 고쳐준다
    const notes = sheet_(NOTE_SHEET);
    const nAll = notes.getDataRange().getValues();
    for (let i = 1; i < nAll.length; i++) {
      if (String(nAll[i][N.pageId]) === pageId && Number(nAll[i][N.index]) === index) {
        notes.getRange(i + 1, N.text + 1).setValue(clean);
        break;
      }
    }

    return { text: clean };
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

/** 페이지 넘김 이어붙이기를 끊거나 다시 잇는다 */
function api_stitch(pageId, on) {
  const sheet = sheet_(PAGE_SHEET);
  const all = sheet.getDataRange().getValues();

  let me = -1;
  for (let i = 1; i < all.length; i++) {
    if (String(all[i][P.id]) === pageId) { me = i; break; }
  }
  if (me < 0) throw new Error('페이지를 찾을 수 없습니다.');

  if (!on) {
    sheet.getRange(me + 1, P.prevId + 1).setValue('');
    return { stitched: false };
  }

  // 같은 책에서 바로 앞에 찍은 페이지를 찾아 잇는다
  let best = null;
  for (let i = 1; i < all.length; i++) {
    if (i === me) continue;
    if (String(all[i][P.book]) !== String(all[me][P.book])) continue;
    if (String(all[i][P.when]) >= String(all[me][P.when])) continue;
    if (!best || String(all[i][P.when]) > String(all[best][P.when])) best = i;
  }
  if (best === null) throw new Error('이어붙일 앞 페이지가 없습니다.');

  sheet.getRange(me + 1, P.prevId + 1).setValue(String(all[best][P.id]));
  return { stitched: true };
}

/** 독서 노트 — 고른 문장만 */
function api_notes(book) {
  return rows_(NOTE_SHEET)
    .filter(function (r) { return !book || String(r[N.book]) === book; })
    .map(function (r) {
      return {
        id: String(r[N.id]),
        pageId: String(r[N.pageId]),
        book: String(r[N.book]),
        page: r[N.page] === '' ? null : Number(r[N.page]),
        text: String(r[N.text]),
        index: Number(r[N.index]),
        when: String(r[N.when])
      };
    })
    .sort(function (a, b) { return a.when < b.when ? 1 : -1; });
}

/** 원본 사진 — 눈으로 대조할 때 */
function api_photo(pageId) {
  const row = findPage_(pageId);
  if (!row || !String(row[P.photo])) throw new Error('원본 사진이 없습니다.');

  const file = DriveApp.getFileById(String(row[P.photo]));
  const blob = file.getBlob();
  return 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

// ──────────────────────── 시트 ────────────────────────

function sheet_(name) {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('시트가 연결되지 않았습니다. Setup.gs 의 저장소_연결 을 먼저 실행하세요.');

  const sheet = SpreadsheetApp.openById(id).getSheetByName(name);
  if (!sheet) throw new Error('시트 탭이 없습니다: ' + name);
  return sheet;
}

/** 헤더를 뺀 값들 */
function rows_(name) {
  const values = sheet_(name).getDataRange().getValues();
  return values.length > 1 ? values.slice(1) : [];
}

function findPage_(pageId) {
  const all = rows_(PAGE_SHEET);
  for (let i = 0; i < all.length; i++) {
    if (String(all[i][P.id]) === pageId) return all[i];
  }
  return null;
}

function parseSentences_(v) {
  if (!v) return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a : [];
  } catch (err) {
    return [];
  }
}

function nextId_(prefix) {
  const props = PropertiesService.getScriptProperties();
  const key = 'SEQ_' + prefix;
  const n = Number(props.getProperty(key) || 0) + 1;
  props.setProperty(key, String(n));
  return prefix + '_' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd') +
         '_' + ('0000' + n).slice(-4);
}
