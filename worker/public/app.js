/**
 * 밑줄 — 화면.
 *
 * v1이 느렸던 진짜 이유는 화면을 옮길 때마다 서버를 부르고, 부를 때마다
 * 시트 전체를 읽은 것이었다. 여기서는 **처음 한 번에 전부 받아 들고 있고**,
 * 이후 화면 이동은 전부 브라우저 안에서 끝낸다. 쓰기는 화면을 먼저 바꾸고
 * 서버로 보낸다(낙관적 갱신).
 */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// ──────────────────────── 접근 토큰 ────────────────────────

const TOKEN_KEY = 'booknote_token';

function readToken() {
  const fromUrl = new URLSearchParams(location.search).get('t');
  if (fromUrl) {
    try { localStorage.setItem(TOKEN_KEY, fromUrl); } catch (e) {}
    history.replaceState(null, '', location.pathname); // 주소창에서 토큰을 지운다
    return fromUrl;
  }
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
}

let token = readToken();

async function api(path, body) {
  const res = await fetch('/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Authorization': 'Bearer ' + token,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) throw new Error('UNAUTHORIZED');
  if (!res.ok) throw new Error((await res.text()).slice(0, 200) || ('HTTP ' + res.status));
  return res.json();
}

// ──────────────────────── 들고 있는 데이터 ────────────────────────

/** { pages: [...], notes: [...] } — 첫 로딩에 통째로 받는다 */
let db = { pages: [], notes: [], books: [] };
let noteFilter = null;   // 밑줄 화면에서 고른 책
let view = { name: 'books' };

const byId = (id) => db.pages.find((p) => p.id === id);
const notesOf = (pageId) => db.notes.filter((n) => n.page_id === pageId);
const infoOf = (book) => (db.books || []).find((b) => b.book === book) || {};

function books() {
  const m = new Map();
  for (const p of db.pages) {
    const b = m.get(p.book) || { book: p.book, pages: 0, notes: 0, last: '' };
    b.pages++;
    if (p.shot_at > b.last) b.last = p.shot_at;
    m.set(p.book, b);
  }
  for (const n of db.notes) {
    const b = m.get(n.book);
    if (b) b.notes++;
  }
  return [...m.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
}

const pagesOf = (book) =>
  db.pages.filter((p) => p.book === book).sort((a, b) => (a.shot_at < b.shot_at ? 1 : -1));

/** 앞 페이지에서 이어진 문장이면 앞 조각을 붙여 보여준다 */
function prevTailOf(page) {
  if (!page.prev_id) return '';
  const prev = byId(page.prev_id);
  if (!prev || !prev.sentences.length) return '';
  return prev.sentences[prev.sentences.length - 1];
}

// ──────────────────────── 잡다한 것 ────────────────────────

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 1900);
}

function chrome({ crumb, title, sub, showBack, showPhoto }) {
  $('crumb').textContent = crumb || '';
  $('crumb').hidden = !crumb;
  $('title').innerHTML = '';
  $('title').append(title);
  if (sub) $('title').append(el('small', null, sub));
  $('back').hidden = !showBack;
  $('photo').hidden = !showPhoto;
}

function render(node) {
  const m = $('main');
  m.innerHTML = '';
  const wrap = el('div', 'view');
  wrap.append(node);
  m.append(wrap);
  scrollTo({ top: 0 });
}

function empty(mark, text) {
  const box = el('div', 'empty');
  box.append(el('b', null, mark), text);
  return box;
}

function skeleton(rows = 4) {
  const f = document.createDocumentFragment();
  for (let i = 0; i < rows; i++) {
    const s = el('div', 'skel');
    s.append(el('i'), el('i'));
    f.append(s);
  }
  return f;
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return (d.getMonth() + 1) + '.' + d.getDate() + '.';
}

// ──────────────────────── 책 목록 ────────────────────────

function showBooks() {
  view = { name: 'books' };
  chrome({ title: '밑줄', showBack: false, showPhoto: false });
  setTab('books');

  const list = books();
  if (!list.length) {
    render(empty('✎', '아직 모은 문장이 없습니다.\n텔레그램 봇에 책 페이지를 찍어 보내주세요.'));
    return;
  }

  const box = el('div');
  for (const b of list) {
    const info = infoOf(b.book);
    const card = el('div', 'card with-cover');

    const body = el('div', 'cbody');
    const h = el('div', 'h');
    h.append(el('b', null, b.book), el('span', 'sp'));
    if (b.notes) h.append(el('span', 'count', b.notes));
    body.append(h);

    if (info.author) body.append(el('div', 'byline', info.author));
    body.append(el('div', 'sub',
      b.pages + '쪽 기록' + (b.notes ? ' · 밑줄 ' + b.notes + '개' : '')));

    card.append(cover(info, b.book), body);
    card.onclick = () => showPages(b.book);
    box.append(card);
  }
  render(box);
}

/** 표지가 없으면 책 이름 첫 글자로 대신한다 — 자리가 비어 보이지 않게 */
function cover(info, book) {
  const box = el('div', 'cover');
  if (info.cover_url) {
    const img = el('img');
    img.src = info.cover_url;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => { box.textContent = book.slice(0, 1); box.classList.add('noimg'); };
    box.append(img);
  } else {
    box.textContent = book.slice(0, 1);
    box.classList.add('noimg');
  }
  return box;
}

// ──────────────────────── 페이지 목록 ────────────────────────

function showPages(book) {
  view = { name: 'pages', book };
  chrome({ crumb: '책', title: book, sub: infoOf(book).author || '', showBack: true, showPhoto: false });
  setTab('books');

  const pages = pagesOf(book);
  if (!pages.length) {
    render(empty('✎', '이 책에 저장된 페이지가 없습니다.'));
    return;
  }

  const box = el('div');
  for (const p of pages) {
    const card = el('div', 'card');
    const h = el('div', 'h');
    h.append(el('b', null, p.page ? p.page + '쪽' : '쪽번호 미상'));
    if (p.prev_id) h.append(el('span', 'pill', '이어짐'));
    h.append(el('span', 'sp'));

    const n = notesOf(p.id).length;
    if (n) h.append(el('span', 'count', n));

    card.append(h, el('div', 'sub', p.sentences[0] || '(빈 페이지)'));
    card.onclick = () => showPage(p.id);
    box.append(card);
  }
  render(box);
}

// ──────────────────────── 페이지 (문장 고르기) ────────────────────────

function showPage(pageId) {
  const p = byId(pageId);
  if (!p) return showBooks();

  view = { name: 'page', id: pageId };
  chrome({
    crumb: p.book,
    title: p.page ? p.page + '쪽' : '쪽번호 미상',
    sub: fmtDate(p.shot_at),
    showBack: true,
    showPhoto: !!p.photo_url
  });
  setTab('books');

  const box = el('div');
  const sheet = el('div', 'sheet-card');
  const tail = prevTailOf(p);

  if (tail || p.starts_mid) {
    const hint = el('div', 'hint');
    if (tail) {
      const prev = byId(p.prev_id);
      hint.append((prev && prev.page ? prev.page + '쪽' : '앞 페이지') + '에서 이어짐');
      const b = el('button', 'txtbtn', '끊기');
      b.onclick = () => stitch(p, false);
      hint.append(b);
    } else {
      hint.append('앞 페이지에서 이어지는 것 같습니다');
      const b = el('button', 'txtbtn', '이어붙이기');
      b.onclick = () => stitch(p, true);
      hint.append(b);
    }
    sheet.append(hint);
  }

  const marked = new Set(notesOf(pageId).map((n) => n.idx));
  p.sentences.forEach((text, i) => sheet.append(sentenceRow(p, i, text, marked.has(i), tail)));
  box.append(sheet);

  if (p.ends_mid) {
    const h = el('div', 'hint');
    h.style.padding = '0 4px 4px';
    h.append('마지막 문장이 다음 페이지로 이어집니다');
    box.append(h);
  }

  render(box);
}

function sentenceRow(page, i, text, on, tail) {
  const row = el('div', 's' + (on ? ' on' : ''));

  const body = el('div', 'body');
  const ink = el('span', 'ink');
  if (i === 0 && tail) {
    ink.append(el('span', 'tail', tail + ' '), document.createTextNode(text));
  } else {
    ink.textContent = text;
  }
  body.append(ink);
  body.onclick = () => toggle(page, i, row);

  const pen = el('button', 'pen', '✎');
  pen.setAttribute('aria-label', '문장 고치기');
  pen.onclick = (e) => { e.stopPropagation(); openEdit(page, i, text); };

  row.append(body, pen);
  return row;
}

/** 밑줄 = 노트 저장. 화면을 먼저 바꾸고 서버로 보낸다. */
async function toggle(page, i, row) {
  const tail = prevTailOf(page);
  const full = (i === 0 && tail) ? tail + ' ' + page.sentences[i] : page.sentences[i];
  const had = notesOf(page.id).some((n) => n.idx === i);

  const add = () => db.notes.push({
    id: 'tmp', page_id: page.id, book: page.book, page: page.page,
    idx: i, text: full, saved_at: new Date().toISOString()
  });
  const drop = () => { db.notes = db.notes.filter((n) => !(n.page_id === page.id && n.idx === i)); };

  row.classList.toggle('on', !had);
  had ? drop() : add();

  try {
    const r = await api('/notes/toggle', { page_id: page.id, idx: i, text: full });
    if (r.on && r.note) {
      const n = db.notes.find((x) => x.page_id === page.id && x.idx === i);
      if (n) Object.assign(n, r.note);
    }
    toast(r.on ? '밑줄을 그었습니다' : '밑줄을 지웠습니다');
  } catch (err) {
    row.classList.toggle('on', had);   // 되돌린다
    had ? add() : drop();
    toast('저장하지 못했습니다');
  }
}

function openEdit(page, i, text) {
  $('editText').value = text;
  const box = $('editBox');
  box.showModal();

  // form method="dialog" 로 닫으면 close 이벤트가 오지 않는 브라우저가 있다.
  // 이벤트에 기대지 말고 버튼 클릭에서 직접 처리한다.
  $('editSave').onclick = async () => {
    box.close();
    const next = $('editText').value.trim();
    if (!next || next === text) return;

    page.sentences[i] = next;                   // 먼저 반영
    const n = db.notes.find((x) => x.page_id === page.id && x.idx === i);
    if (n) n.text = next;
    showPage(page.id);

    try {
      await api('/pages/' + page.id + '/sentence', { idx: i, text: next });
      toast('고쳤습니다');
    } catch (err) {
      page.sentences[i] = text;
      if (n) n.text = text;
      showPage(page.id);
      toast('고치지 못했습니다');
    }
  };
}

async function stitch(page, on) {
  try {
    const r = await api('/pages/' + page.id + '/stitch', { on });
    page.prev_id = r.prev_id || null;
    showPage(page.id);
    toast(on ? '이어붙였습니다' : '끊었습니다');
  } catch (err) {
    toast(String(err.message || err));
  }
}

$('photo').onclick = () => {
  const p = byId(view.id);
  if (!p || !p.photo_url) return;
  $('photoCap').textContent = p.book + (p.page ? ' · ' + p.page + '쪽' : '');
  $('photoImg').src = p.photo_url;
  $('photoBox').showModal();
};

// ──────────────────────── 밑줄 ────────────────────────

function showNotes() {
  view = { name: 'notes' };
  chrome({ title: '밑줄', sub: db.notes.length + '개', showBack: false, showPhoto: false });
  setTab('notes');

  if (!db.notes.length) {
    render(empty('✎', '아직 그은 밑줄이 없습니다.\n페이지를 열어 마음에 드는 문장을 눌러보세요.'));
    return;
  }

  const box = el('div');
  const names = [...new Set(db.notes.map((n) => n.book))];

  if (names.length > 1) {
    const chips = el('div', 'chips');
    const mk = (label, value) => {
      const c = el('button', 'chip' + (noteFilter === value ? ' on' : ''), label);
      c.onclick = () => { noteFilter = value; showNotes(); };
      return c;
    };
    chips.append(mk('전체', null));
    for (const b of names) chips.append(mk(b, b));
    box.append(chips);
  }

  const shown = db.notes.filter((n) => !noteFilter || n.book === noteFilter);

  // 시간순으로만 늘어놓으면 두 책을 번갈아 읽었을 때 같은 제목이 여러 번
  // 튀어나와 묶음이 되지 않는다. 책으로 먼저 묶고, 책끼리는 최근에 그은
  // 밑줄이 있는 쪽을 위로 올린다.
  const latest = {};
  for (const n of shown) {
    if (!latest[n.book] || latest[n.book] < n.saved_at) latest[n.book] = n.saved_at;
  }
  // 책 안에서는 pos 순서다. 기본값이 읽는 순서(쪽·문장 번호)라 처음에는
  // 책을 읽는 차례대로 서고, 손으로 끌어 옮기면 그 자리가 유지된다.
  shown.sort((a, b) => (a.book === b.book
    ? (a.pos || 0) - (b.pos || 0)
    : (latest[a.book] < latest[b.book] ? 1 : -1)));

  // 책별로 묶어 보여준다 — v1에 없어서 아쉬웠던 부분
  let lastBook = null;
  for (const n of shown) {
    if (n.book !== lastBook) {
      const h = el('div', 'group-h');
      h.append(el('i', null, n.book));
      box.append(h);
      lastBook = n.book;
    }
    box.append(quoteRow(n));
  }
  render(box);
}

const byNote = (id) => db.notes.find((n) => n.id === id);

/**
 * 밑줄 끌어 옮기기.
 *
 * 끌려가는 카드를 따로 띄우지 않고 목록 안에서 바로 옮겨 끼운다.
 * 보이는 것이 곧 결과라 어디에 놓일지 헷갈릴 일이 없다.
 * 자리는 같은 책 안에서만 바뀐다 — 책을 건너뛰면 쪽번호가 뒤엉킨다.
 */
function startDrag(e, row) {
  e.preventDefault();

  const box = row.parentNode;
  const book = row.dataset.book;
  const rows = [...box.querySelectorAll('.quote')].filter((q) => q.dataset.book === book);
  const from = rows.indexOf(row);
  if (rows.length < 2) return;

  // 시작할 때의 자리를 문서 좌표로 재어 둔다. 끄는 동안 DOM 은 건드리지 않고
  // 전부 transform 으로만 움직인다. 그래야 재는 값이 흔들리지 않는다.
  const scroll0 = window.scrollY;
  const at = rows.map((q) => {
    const r = q.getBoundingClientRect();
    return { top: r.top + scroll0, h: r.height };
  });
  const gap = at[1] ? at[1].top - (at[0].top + at[0].h) : 13;
  const shift = at[from].h + gap;
  const grabY = e.clientY + scroll0;

  let to = from;
  const grip = e.currentTarget;
  dragging = true;
  row.classList.add('dragging');
  try { grip.setPointerCapture(e.pointerId); } catch (err) {}   // 빨리 움직여도 놓치지 않게

  const onMove = (ev) => {
    const dy = ev.clientY + window.scrollY - grabY;
    row.style.setProperty('--dy', dy + 'px');   // 들어올린 카드는 손가락을 그대로 따라간다

    // 어디에 놓일지는 카드 한가운데가 어느 카드들을 지나왔는지로 정한다.
    // 한 번에 여러 칸을 건너뛰어도 그만큼 간다.
    const mid = at[from].top + dy + at[from].h / 2;
    to = from;
    for (let k = 0; k < rows.length; k++) {
      if (k === from) continue;
      const c = at[k].top + at[k].h / 2;
      if (k < from && mid < c) to = Math.min(to, k);
      if (k > from && mid > c) to = Math.max(to, k);
    }

    // 사이에 낀 카드들이 한 칸씩 비켜선다. 전환이 걸려 있어 미끄러지듯 움직인다.
    for (let k = 0; k < rows.length; k++) {
      if (k === from) continue;
      const d = (from < to && k > from && k <= to) ? -shift
        : (from > to && k >= to && k < from) ? shift : 0;
      rows[k].style.setProperty('--dy', d + 'px');
    }

    // 목록 끝까지 끌 때 화면도 같이 따라간다
    if (ev.clientY < 90) window.scrollBy(0, -14);
    else if (ev.clientY > window.innerHeight - 90) window.scrollBy(0, 14);
  };

  const onUp = async () => {
    grip.removeEventListener('pointermove', onMove);
    grip.removeEventListener('pointerup', onUp);
    grip.removeEventListener('pointercancel', onUp);

    dragging = false;
    row.classList.remove('dragging');
    rows.forEach((q) => q.style.removeProperty('--dy'));
    if (to === from) return;

    // 눈에 보이던 자리 그대로 DOM 을 옮긴다. transform 은 방금 지웠으므로 튀지 않는다.
    if (to > from) box.insertBefore(row, rows[to].nextSibling);
    else box.insertBefore(row, rows[to]);

    const order = rows.filter((q) => q !== row);
    order.splice(to, 0, row);

    // 위아래 이웃 사이의 값을 준다. 옮기지 않은 밑줄의 자리는 건드리지 않는다.
    const posOf = (q) => (q ? (byNote(q.dataset.id).pos || 0) : null);
    const up = posOf(order[to - 1]);
    const down = posOf(order[to + 1]);
    const pos = up == null && down == null ? 0
      : up == null ? down - 1000
      : down == null ? up + 1000
      : (up + down) / 2;

    const note = byNote(row.dataset.id);
    const old = note.pos;
    note.pos = pos;                       // 화면은 이미 바뀌었다. 서버는 뒤따라온다.

    try {
      await api('/notes/move', { id: note.id, pos });
    } catch (err) {
      note.pos = old;
      toast('자리를 옮기지 못했습니다');
      showNotes();
    }
  };

  grip.addEventListener('pointermove', onMove);
  grip.addEventListener('pointerup', onUp);
  grip.addEventListener('pointercancel', onUp);
}

function quoteRow(n) {
  const wrap = el('div', 'quote');
  wrap.dataset.id = n.id;
  wrap.dataset.book = n.book;
  wrap.append(el('div', 'q', n.text));

  const src = el('div', 'src');

  // 끌어 옮기는 손잡이. 본문을 직접 끌게 하면 폰에서 스크롤과 다툰다.
  const grip = el('button', 'grip', '⠿');
  grip.title = '끌어서 자리 옮기기';
  grip.onpointerdown = (e) => startDrag(e, wrap);
  src.append(grip);

  src.append(el('span', 'grow', n.page ? n.page + '쪽' : '쪽번호 미상'));

  const go = el('button', 'txtbtn', '원문');
  go.onclick = () => showPage(n.page_id);

  const copy = el('button', 'txtbtn', '복사');
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(n.text); toast('복사했습니다'); }
    catch (e) { toast('복사하지 못했습니다'); }
  };

  src.append(go, copy);
  wrap.append(src);
  return wrap;
}

// ──────────────────────── 이동 ────────────────────────

function setTab(which) {
  $('tabBooks').classList.toggle('on', which === 'books');
  $('tabNotes').classList.toggle('on', which === 'notes');
}

$('back').onclick = () => {
  if (view.name === 'page') {
    const p = byId(view.id);
    p ? showPages(p.book) : showBooks();
  } else {
    showBooks();
  }
};

$('tabBooks').onclick = () => showBooks();
$('tabNotes').onclick = () => { noteFilter = null; showNotes(); };

// ──────────────────────── 다시 받아오기 ────────────────────────

/** 지금 보고 있는 화면을 그대로 다시 그린다 */
function rerender() {
  if (view.name === 'pages') return showPages(view.book);
  if (view.name === 'page') return showPage(view.id);
  if (view.name === 'notes') return showNotes();
  return showBooks();
}

/**
 * 봇으로 찍은 페이지는 서버에만 쌓인다. 앱은 열 때 한 번만 받아오므로
 * 홈 화면에 띄워둔 채로 두면 새 페이지가 영영 보이지 않았다.
 * 화면으로 돌아올 때마다 다시 받아온다 — 찍고 앱으로 넘어오는 것이
 * 이 앱에서 가장 잦은 동작이다.
 */
let lastLoad = 0;
let dragging = false;

async function refresh() {
  // 끌고 있는 중에 다시 그리면 손에서 카드가 사라진다
  if (dragging || !token || Date.now() - lastLoad < 15000) return;
  try {
    db = await api('/bootstrap');
    lastLoad = Date.now();
    rerender();
  } catch (e) {
    // 조용히 둔다. 보고 있던 화면이 오류로 바뀌면 그게 더 나쁘다.
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});
window.addEventListener('focus', refresh);

// ──────────────────────── 시작 ────────────────────────

async function boot() {
  chrome({ title: '밑줄', showBack: false, showPhoto: false });
  render(skeleton());

  if (!token) {
    render(empty('🔒', '접근 권한이 없습니다.\n텔레그램 봇에서 /앱 을 보내\n받은 링크로 열어주세요.'));
    return;
  }

  try {
    db = await api('/bootstrap');
    lastLoad = Date.now();
    showBooks();
  } catch (err) {
    if (String(err.message) === 'UNAUTHORIZED') {
      try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
      render(empty('🔒', '링크가 만료되었습니다.\n텔레그램 봇에서 /앱 을 다시 보내주세요.'));
    } else {
      render(empty('⚠', '불러오지 못했습니다.\n' + String(err.message || err)));
    }
  }
}

boot();
