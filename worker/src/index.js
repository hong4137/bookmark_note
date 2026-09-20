/**
 * 밑줄 — Cloudflare Worker.
 *
 *   텔레그램 웹훅 → Gemini 문장 파싱 → 드라이브 어댑터(사진) → D1
 *   앱 화면(정적 파일) + 앱 API
 *
 * 배경은 ../../설계-v2.md.
 *
 * 웹훅을 쓸 수 있는 이유: Apps Script 와 달리 Worker 는 302 를 돌려주지 않는다.
 * v1 이 폴링으로 돌아섰던 이유가 그 302 였다.
 *
 * 시크릿 (wrangler secret put):
 *   TELEGRAM_BOT_TOKEN   봇 토큰
 *   TELEGRAM_SECRET      setWebhook 의 secret_token 과 같은 값
 *   GEMINI_API_KEY       https://aistudio.google.com/apikey
 *   DRIVE_SECRET         드라이브 어댑터와 나눠 가진 암호
 *   ADMIN_SECRET         시트 → D1 이전용
 *   ALADIN_TTB_KEY       알라딘 Open API 키 (표지·서지. 없으면 표지만 안 나온다)
 * 변수 (wrangler.toml [vars]):
 *   ALLOWED_CHATS        쉼표로 구분한 텔레그램 챗 ID
 *   DRIVE_ADAPTER_URL    Apps Script 어댑터의 /exec 주소
 *   APP_URL              배포된 Worker 주소 (봇 답장의 앱 링크)
 *   GEMINI_MODEL         (선택) 모델 교체. 비우면 DEFAULT_MODEL
 */

/** 기본값. wrangler.toml 의 [vars] GEMINI_MODEL 로 덮어쓸 수 있다.
 *  무료 등급 하루 한도는 모델마다 다르다. 3.6-flash 는 하루 20건으로 빠듯하다. */
const DEFAULT_MODEL = 'gemini-3.6-flash';

/** 쪽번호가 없을 때, 직전 사진과 이 시간 안이면 같은 흐름으로 본다 */
const STITCH_WINDOW_MS = 10 * 60 * 1000;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    try {
      if (url.pathname === '/tg' && req.method === 'POST') return telegramHook(req, env, ctx);
      if (url.pathname.startsWith('/api/')) return apiRoute(req, env, url);
      if (url.pathname === '/admin/import' && req.method === 'POST') return adminImport(req, env);
    } catch (err) {
      console.error(err.stack || String(err));
      return json({ error: String(err.message || err) }, 500);
    }

    return env.ASSETS.fetch(req);   // 나머지는 앱 화면
  }
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' }
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ════════════════════════════ 앱 API ════════════════════════════

async function apiRoute(req, env, url) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthorized' }, 401);

  const ok = await env.DB.prepare('SELECT 1 FROM app_tokens WHERE token = ?').bind(token).first();
  if (!ok) return json({ error: 'unauthorized' }, 401);

  const path = url.pathname.slice(4);   // /api 를 떼어낸 나머지
  const body = req.method === 'POST' ? await req.json() : {};

  // 잘못된 요청은 400 으로 돌려준다. 화면이 사용자에게 그대로 보여주기 때문이다.
  try {
    if (path === '/bootstrap') return json(await bootstrap(env));
    if (path === '/notes/toggle') return json(await toggleNote(env, body));

    const m = path.match(/^\/pages\/([^/]+)\/(sentence|stitch)$/);
    if (m) {
      if (m[2] === 'sentence') return json(await editSentence(env, m[1], body));
      return json(await setStitch(env, m[1], body.on));
    }
  } catch (err) {
    console.error(err.stack || String(err));
    return new Response(String(err.message || err), { status: 400 });
  }

  return json({ error: 'not found' }, 404);
}

/** 첫 로딩에 전부 내려준다 — 화면 이동마다 서버를 부르지 않기 위해서다 */
async function bootstrap(env) {
  const [pages, notes, books] = await Promise.all([
    env.DB.prepare('SELECT * FROM pages ORDER BY shot_at').all(),
    env.DB.prepare('SELECT * FROM notes ORDER BY saved_at').all(),
    env.DB.prepare('SELECT book, title, author, publisher, cover_url FROM books').all()
  ]);

  return {
    books: books.results,
    pages: pages.results.map((p) => ({
      id: p.id,
      book: p.book,
      page: p.page,
      shot_at: p.shot_at,
      sentences: safeParse(p.sentences),
      starts_mid: p.starts_mid,
      ends_mid: p.ends_mid,
      prev_id: p.prev_id,
      photo_url: photoUrl(p.photo_id)
    })),
    notes: notes.results
  };
}

/** 드라이브 파일을 브라우저가 바로 띄울 수 있는 주소로 */
const photoUrl = (id) =>
  id ? 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1600' : null;

async function toggleNote(env, { page_id, idx, text }) {
  const found = await env.DB
    .prepare('SELECT id FROM notes WHERE page_id = ? AND idx = ?').bind(page_id, idx).first();

  if (found) {
    await env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(found.id).run();
    return { on: false };
  }

  const page = await env.DB.prepare('SELECT book, page FROM pages WHERE id = ?').bind(page_id).first();
  if (!page) throw new Error('페이지를 찾을 수 없습니다.');

  const note = {
    id: newId('n'),
    page_id, book: page.book, page: page.page,
    idx, text, memo: null, saved_at: new Date().toISOString()
  };

  await env.DB.prepare(
    'INSERT INTO notes (id, page_id, book, page, idx, text, memo, saved_at) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(note.id, note.page_id, note.book, note.page, note.idx, note.text, null, note.saved_at).run();

  return { on: true, note };
}

async function editSentence(env, pageId, { idx, text }) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('빈 문장으로는 바꿀 수 없습니다.');

  const page = await env.DB.prepare('SELECT sentences FROM pages WHERE id = ?').bind(pageId).first();
  if (!page) throw new Error('페이지를 찾을 수 없습니다.');

  const sentences = safeParse(page.sentences);
  if (idx < 0 || idx >= sentences.length) throw new Error('없는 문장입니다.');
  sentences[idx] = clean;

  await env.DB.batch([
    env.DB.prepare('UPDATE pages SET sentences = ?, raw = ? WHERE id = ?')
      .bind(JSON.stringify(sentences), sentences.join(' '), pageId),
    // 이미 밑줄 그은 문장이면 노트 쪽도 같이 고친다
    env.DB.prepare('UPDATE notes SET text = ? WHERE page_id = ? AND idx = ?')
      .bind(clean, pageId, idx)
  ]);

  return { text: clean };
}

async function setStitch(env, pageId, on) {
  if (!on) {
    await env.DB.prepare('UPDATE pages SET prev_id = NULL WHERE id = ?').bind(pageId).run();
    return { prev_id: null };
  }

  const me = await env.DB.prepare('SELECT book, shot_at FROM pages WHERE id = ?').bind(pageId).first();
  if (!me) throw new Error('페이지를 찾을 수 없습니다.');

  const prev = await previousPage(env, me.book, me.shot_at);
  if (!prev) throw new Error('이어붙일 앞 페이지가 없습니다.');

  await env.DB.prepare('UPDATE pages SET prev_id = ? WHERE id = ?').bind(prev.id, pageId).run();
  return { prev_id: prev.id };
}

const previousPage = (env, book, before) => env.DB
  .prepare('SELECT * FROM pages WHERE book = ? AND shot_at < ? ORDER BY shot_at DESC LIMIT 1')
  .bind(book, before).first();

// ════════════════════════════ 텔레그램 ════════════════════════════

function telegramHook(req, env, ctx) {
  // setWebhook 의 secret_token 이 헤더로 온다. Worker 는 헤더를 읽을 수 있다.
  // 시크릿이 비어 있으면 검사가 무의미하므로 아예 받지 않는다.
  if (!env.TELEGRAM_SECRET ||
      req.headers.get('x-telegram-bot-api-secret-token') !== env.TELEGRAM_SECRET) {
    return new Response('no', { status: 401 });
  }

  // 파싱은 수십 초가 걸린다. 텔레그램에는 먼저 200 을 돌려주고 뒤에서 일한다.
  return req.json().then((update) => {
    ctx.waitUntil(handleUpdate(update, env).catch((err) => {
      console.error(err.stack || String(err));

      // 여기서 말없이 끝내면 사진을 아예 못 받은 것처럼 보인다.
      // 사진을 여러 장 한꺼번에 보냈을 때 한 장만 답장이 오던 증상이 이것이었다.
      const msg = update.message || update.channel_post;
      if (!msg || !msg.chat) return;
      return reply(env, msg.chat.id, '⚠️ 이 사진을 처리하지 못했습니다.\n\n<code>' +
        esc(String(err.message || err)).slice(0, 500) + '</code>');
    }));
    return new Response('ok');
  });
}

const tg = (env, method, payload) =>
  fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  }).then((r) => r.json());

const reply = (env, chatId, html) =>
  tg(env, 'sendMessage', {
    chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true
  });

async function handleUpdate(update, env) {
  const msg = update.message || update.channel_post;
  if (!msg || !msg.chat) return;

  const chatId = msg.chat.id;
  const allowed = String(env.ALLOWED_CHATS || '').split(',').map((s) => s.trim());
  if (!allowed.includes(String(chatId))) {
    console.warn('미승인 접근: chat_id=' + chatId);
    return reply(env, chatId, '이 봇은 지정된 사용자만 사용할 수 있습니다.');
  }

  // 여러 장을 한꺼번에 보내면 텔레그램은 같은 media_group_id 로 update 를 따로 보낸다.
  // 몇 장이 실제로 도착했는지는 이 줄로만 알 수 있다.
  console.log('update ' + msg.message_id +
              (msg.media_group_id ? ' / 앨범 ' + msg.media_group_id : '') +
              (msg.photo ? ' / 사진' : ''));

  const text = (msg.text || '').trim();

  if (text.startsWith('/책')) return cmdBook(env, chatId, text.slice(2).trim());
  if (text.startsWith('/모델')) return cmdModel(env, chatId);
  if (text.startsWith('/표지')) return cmdCover(env, chatId, text.slice(3).trim());
  if (text.startsWith('/앱초기화')) return cmdResetApp(env, chatId);   // /앱 보다 먼저 봐야 한다
  if (text.startsWith('/앱')) return cmdApp(env, chatId);
  if (text.startsWith('/start')) return cmdHelp(env, chatId);

  const fileId = pickImage(msg);
  if (fileId) return onPhoto(env, chatId, fileId, (msg.caption || '').trim());

  if (text) return cmdHelp(env, chatId);
}

function pickImage(msg) {
  if (msg.photo && msg.photo.length) return msg.photo[msg.photo.length - 1].file_id;
  if (msg.document && /^image\//.test(msg.document.mime_type || '')) return msg.document.file_id;
  return null;
}

const getState = (env, k) => env.DB.prepare('SELECT v FROM state WHERE k = ?').bind(k).first()
  .then((r) => (r ? r.v : null));

const setState = (env, k, v) => env.DB
  .prepare('INSERT INTO state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
  .bind(k, v).run();

/**
 * "데미안 - 헤르만 헤세" 를 책 이름과 지은이로 가른다.
 *
 * 제목만으로 찾으면 같은 제목의 다른 책을 가져오는 일이 잦아서, 지은이를
 * 같이 받는다. 구분자는 공백을 낀 ` - ` 나 ` / ` 만 본다. 제목 안의 하이픈·
 * 콜론까지 자르면 멀쩡한 제목이 잘리기 때문이다.
 */
function splitBook(raw) {
  const m = String(raw).match(/^(.+?)\s+[-–—/]\s+(.+)$/);
  return m ? { book: m[1].trim(), author: m[2].trim() }
           : { book: String(raw).trim(), author: '' };
}

async function cmdBook(env, chatId, rest) {
  if (!rest) {
    const now = await getState(env, '현재_책');
    return reply(env, chatId, now
      ? '지금 읽는 책: <b>' + esc(now) + '</b>'
      : '아직 책을 정하지 않았습니다.\n<b>/책 데미안 - 헤르만 헤세</b> 처럼 보내주세요.');
  }

  const { book, author } = splitBook(rest);
  await setState(env, '현재_책', book);
  const found = await lookupBook(env, book, book, author);

  const lines = ['📖 <b>' + esc(book) + '</b>' + josaRo(book) + ' 설정했습니다.'];

  if (found && found.cover_url) {
    lines.push('<i>' + esc([found.author, found.publisher].filter(Boolean).join(' · ')) + '</i>');
  } else if (found) {
    lines.push('<i>' + esc(found.author || '') + ' · 표지는 못 찾았습니다</i>');
  } else if (!author) {
    lines.push('<i>표지를 못 찾았습니다. <b>/책 제목 - 지은이</b> 로 알려주시면 더 잘 찾습니다</i>');
  }

  lines.push('이제 페이지 사진을 보내주세요.');
  return reply(env, chatId, lines.join('\n'));
}

/** 표지를 잘못 찾아왔을 때, 더 정확한 제목으로 다시 찾는다 */
async function cmdCover(env, chatId, rest) {
  const book = await getState(env, '현재_책');
  if (!book) return reply(env, chatId, '먼저 <b>/책 데미안 - 헤르만 헤세</b> 처럼 책을 정해주세요.');

  // 책 이름은 그대로 두고 검색어만 바꾼다. 앱에서 쓰는 이름이 바뀌면
  // 이미 쌓인 페이지와 갈라지기 때문이다.
  const { book: title, author } = splitBook(rest || book);
  const found = await lookupBook(env, book, title, author);

  if (!found) {
    return reply(env, chatId, '표지를 찾지 못했습니다.\n' +
      '<b>/표지 정확한 제목 - 지은이</b> 로 알려주시면 그걸로 다시 찾습니다.');
  }
  if (!found.cover_url) {
    return reply(env, chatId, '지은이는 <b>' + esc(found.author || '') + '</b> 로 적어 뒀습니다.\n' +
      '표지는 못 찾았습니다.');
  }

  return reply(env, chatId, '🖼 <b>' + esc(found.title || book) + '</b>\n' +
    esc([found.author, found.publisher].filter(Boolean).join(' · ')) +
    '\n\n<a href="' + found.cover_url + '">표지 보기</a>');
}

/**
 * 알라딘 Open API 로 표지와 서지 정보를 찾아 books 에 넣는다.
 * 키가 없거나 못 찾아도 그냥 넘어간다 — 표지는 있으면 좋은 것이지 필수가 아니다.
 *
 * `book` 은 앱에서 쓰는 이름(= /책 으로 정한 이름), `query` 는 검색어다.
 * 보통 같지만, /표지 로 더 정확한 제목을 줄 수 있어서 나눠 둔다.
 */
async function lookupBook(env, book, title, author) {
  // 지은이를 알면 제목만 볼 때보다 훨씬 정확해진다. 그때는 둘을 합쳐 키워드로 찾는다.
  const query = author ? (title || book) + ' ' + author : (title || book);

  if (!env.ALADIN_TTB_KEY) {
    // 키가 없어도 사용자가 알려준 지은이는 적어 둔다
    return author ? saveBook(env, book, { author }) : null;
  }

  try {
    const url = 'https://www.aladin.co.kr/ttb/api/ItemSearch.aspx?' + new URLSearchParams({
      ttbkey: env.ALADIN_TTB_KEY,
      Query: query,
      QueryType: author ? 'Keyword' : 'Title',
      MaxResults: '1',
      start: '1',
      SearchTarget: 'Book',
      Cover: 'Big',
      output: 'js',
      Version: '20131101'
    });

    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 200));

    // output=js 인데도 끝에 세미콜론이 붙어 오는 경우가 있다
    const data = JSON.parse(text.trim().replace(/;$/, ''));
    const it = data.item && data.item[0];

    // 못 찾아도 사용자가 알려준 지은이는 남긴다. 표지는 없어도 지은이는 쓸모가 있다.
    if (!it) return author ? saveBook(env, book, { author }) : null;

    return saveBook(env, book, {
      title: it.title || null,
      author: it.author || author || null,
      publisher: it.publisher || null,
      isbn13: it.isbn13 || null,
      cover_url: it.cover || null
    });
  } catch (err) {
    console.error('표지 조회 실패: ' + (err.stack || err));
    return author ? saveBook(env, book, { author }) : null;
  }
}

async function saveBook(env, book, row) {
  const r = {
    title: row.title || null,
    author: row.author || null,
    publisher: row.publisher || null,
    isbn13: row.isbn13 || null,
    cover_url: row.cover_url || null
  };

  await env.DB.prepare(
    'INSERT INTO books (book, title, author, publisher, isbn13, cover_url, looked_up_at)' +
    ' VALUES (?,?,?,?,?,?,?)' +
    ' ON CONFLICT(book) DO UPDATE SET title=excluded.title, author=excluded.author,' +
    ' publisher=excluded.publisher, isbn13=excluded.isbn13, cover_url=excluded.cover_url,' +
    ' looked_up_at=excluded.looked_up_at'
  ).bind(book, r.title, r.author, r.publisher, r.isbn13, r.cover_url,
         new Date().toISOString()).run();

  return r;
}

/** 받침에 따라 '으로' / '로' — "데미안으로", "AI리터러시로" */
function josaRo(word) {
  const code = String(word).trim().slice(-1).charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return '으로';
  const jong = code % 28;
  return (jong === 0 || jong === 8) ? '로' : '으로';
}

/** 앱은 이 토큰으로만 열린다. 도메인이 없어 Cloudflare Access 를 못 쓰기 때문이다. */
async function cmdApp(env, chatId) {
  const token = crypto.randomUUID().replace(/-/g, '');
  await env.DB.prepare('INSERT INTO app_tokens (token, created_at) VALUES (?, ?)')
    .bind(token, new Date().toISOString()).run();

  const base = env.APP_URL || '';
  return reply(env, chatId,
    '🔖 <a href="' + base + '/?t=' + token + '">밑줄 열기</a>\n\n' +
    '<i>이 링크에 접근 권한이 들어 있습니다. 한 번 열면 그 기기에 기억됩니다.</i>');
}

/**
 * 지금 쓰는 모델과 고를 수 있는 목록을 보여준다.
 *
 * 모델을 바꾸는 것은 wrangler.toml 의 [vars] 라 봇에서 바꾸지는 않는다.
 * 목록 조회는 generateContent 한도와 별개여서, 한도를 넘긴 뒤에도 쓸 수 있다.
 */
async function cmdModel(env, chatId) {
  const now = env.GEMINI_MODEL || DEFAULT_MODEL;

  try {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' +
      encodeURIComponent(env.GEMINI_API_KEY));
    const body = await res.json();

    const names = (body.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace('models/', ''))
      .filter((n) => /flash|lite/.test(n))   // 이 용도엔 가벼운 모델이면 충분하다
      .slice(0, 25);

    return reply(env, chatId, [
      '지금 쓰는 모델: <b>' + esc(now) + '</b>',
      '',
      '가벼운 모델일수록 무료 하루 한도가 큽니다.',
      names.map((n) => (n === now ? '• <b>' + esc(n) + '</b> ←' : '• ' + esc(n))).join('\n'),
      '',
      '<i>바꾸려면 wrangler.toml 의 [vars] 에</i>',
      '<code>GEMINI_MODEL = "고른 이름"</code>',
      '<i>을 넣고 npx wrangler deploy 하세요.</i>'
    ].join('\n'));
  } catch (err) {
    return reply(env, chatId,
      '모델 목록을 못 가져왔습니다.\n지금 쓰는 모델: <b>' + esc(now) + '</b>');
  }
}

/**
 * 발급한 앱 링크를 전부 무효로 만든다.
 * 링크를 아는 사람은 내 밑줄을 다 읽을 수 있으므로, 흘렸다 싶으면 이걸 쓴다.
 */
async function cmdResetApp(env, chatId) {
  const res = await env.DB.prepare('DELETE FROM app_tokens').run();
  const n = (res.meta && res.meta.changes) || 0;
  return reply(env, chatId,
    '🔒 앱 링크 ' + n + '개를 모두 무효로 만들었습니다.\n' +
    '내 기기에서도 로그아웃되니 <b>/앱</b> 으로 새 링크를 받으세요.');
}

const cmdHelp = (env, chatId) => reply(env, chatId, [
  '🔖 <b>밑줄</b>',
  '',
  '<b>/책 데미안 - 헤르만 헤세</b> — 읽는 책 정하기',
  '     지은이를 같이 주면 표지를 훨씬 잘 찾습니다',
  '<b>/책</b> — 지금 무슨 책인지',
  '<b>/앱</b> — 밑줄 앱 열기',
  '<b>/표지 제목 - 지은이</b> — 표지를 잘못 찾았을 때 다시 찾기',
  '<b>/모델</b> — 지금 쓰는 Gemini 모델과 고를 수 있는 목록',
  '<b>/앱초기화</b> — 발급한 앱 링크를 모두 무효로',
  '',
  '<b>표지를 찍어 보내면</b> 책이 자동으로 바뀝니다. 타이핑이 필요 없습니다.',
  '그 뒤 페이지 사진을 보내면 문장 단위로 저장합니다.',
  '펼친 양면으로 찍으면 문장이 잘리지 않아 더 깔끔합니다.'
].join('\n'));

// ──────────────────────── 사진 처리 ────────────────────────

async function onPhoto(env, chatId, fileId, caption) {
  // 책이 안 정해져 있어도 일단 읽어본다. 표지 사진이면 그걸로 책을 정할 수 있기 때문이다.
  const book = await getState(env, '현재_책');

  await tg(env, 'sendChatAction', { chat_id: chatId, action: 'typing' });

  let bytes, mime;
  try {
    const got = await tg(env, 'getFile', { file_id: fileId });
    const res = await fetch('https://api.telegram.org/file/bot' +
      env.TELEGRAM_BOT_TOKEN + '/' + got.result.file_path);
    if (!res.ok) throw new Error('사진 다운로드 실패 (HTTP ' + res.status + ')');
    bytes = await res.arrayBuffer();
    // 텔레그램 파일 CDN 이 application/octet-stream 을 줄 때가 있다.
    // 그대로 넘기면 Gemini 가 이미지를 이미지로 보지 않는다. 사진은 늘 JPEG 다.
    mime = res.headers.get('content-type') || '';
    if (!/^image\//.test(mime)) mime = 'image/jpeg';
    console.log('사진 수신: ' + Math.round(bytes.byteLength / 1024) + 'KB, ' +
                (res.headers.get('content-type') || '(타입 없음)') + ' → ' + mime);
  } catch (err) {
    return reply(env, chatId, '⚠️ 사진을 가져오지 못했습니다.\n\n<code>' + esc(String(err.message)) + '</code>');
  }

  const now = new Date();
  const base64 = toBase64(bytes);

  // 파싱보다 먼저 저장한다. 파싱이 실패해도 원본은 남아야 한다.
  let photoId = null;
  try {
    photoId = await saveToDrive(env, base64, mime, book || '표지', now);
  } catch (err) {
    console.error('드라이브 저장 실패: ' + err);   // 저장 실패해도 파싱은 계속한다
  }

  let parsed;
  try {
    parsed = await parsePage(env, base64, mime);
  } catch (err) {
    console.error(err.stack || String(err));

    // 하루 한도를 넘긴 것은 고장이 아니다. 무슨 일인지 사람 말로 알려준다.
    const q = String(err.message || '').match(/^QUOTA:(\S+?):(\S+)$/);
    if (q) {
      return reply(env, chatId,
        '📵 오늘 <b>' + esc(q[2]) + '</b> 무료 사용량을 다 썼습니다 (하루 ' + esc(q[1]) + '건).\n' +
        '한국 시간 기준 <b>오후 4시</b>쯤 다시 열립니다.\n\n' +
        '<i>한도가 더 큰 모델로 바꾸려면 <b>/모델</b> 을 보내보세요.</i>');
    }

    return reply(env, chatId, '⚠️ 처리 중 문제가 생겼습니다.\n\n<code>' +
      esc(String(err.message || err)).slice(0, 700) + '</code>');
  }

  const kind = String(parsed.kind || '').toLowerCase();
  const title = (parsed.book_title || '').trim();
  console.log('판정: kind=' + kind + ' / 제목=' + title +
              ' / 지은이=' + (parsed.book_author || '') + ' / 문장=' + parsed.sentences.length);

  // 표지를 찍었으면 그걸로 읽는 책을 바꾼다. 타이핑 없이 새 책을 시작할 수 있다.
  //
  // kind 를 곧이곧대로 믿지 않는다. 표지에도 띠지·추천사·수상 문구가 많아서
  // 'page' 로 잘못 보는 일이 있다. 제목을 읽어냈고 본문 문단이 없으면 표지로 본다.
  if (title && (kind === 'cover' || !parsed.sentences.length)) {
    return onCover(env, chatId, parsed, photoId);
  }

  if (!book) {
    const hint = title ? '\n<i>읽어낸 제목: ' + esc(title) + ' (본문으로 보여 그냥 두었습니다)</i>'
                       : (kind ? '\n<i>이 사진은 ' + esc(kind) + ' 으로 보입니다</i>' : '');
    return reply(env, chatId, '먼저 책을 정해주세요.\n' +
      '<b>표지를 찍어 보내시거나</b>, <b>/책 데미안 - 헤르만 헤세</b> 처럼 알려주세요.' + hint);
  }

  if (!parsed.sentences.length) {
    return reply(env, chatId,
      '글자를 읽어내지 못했습니다. 밝은 곳에서 페이지가 평평하게 펴지도록 다시 찍어주세요. 📷');
  }

  // 같은 쪽을 다시 찍는 일이 잦다. 더 잘 나온 사진으로 다시 찍거나, 앨범에 섞여
  // 딸려 들어오거나. 그냥 넣으면 앱에 같은 쪽이 두 벌 뜬다.
  // 쪽번호를 읽어냈을 때만 판단할 수 있다 — 못 읽었으면 별개로 둔다.
  const dup = parsed.page_number == null ? null : await env.DB.prepare(
    'SELECT p.*, (SELECT COUNT(*) FROM notes n WHERE n.page_id = p.id) AS notes' +
    ' FROM pages p WHERE p.book = ? AND p.page = ? ORDER BY p.shot_at LIMIT 1'
  ).bind(book, parsed.page_number).first();

  // 밑줄이 붙어 있으면 손대지 않는다. 문장이 한 칸이라도 밀리면 밑줄이 엉뚱한
  // 문장을 가리키게 된다. 밑줄은 이 시스템에서 유일하게 사람이 직접 만든 것이다.
  if (dup && dup.notes > 0) {
    return reply(env, chatId,
      '📎 <b>' + esc(book) + '</b> ' + parsed.page_number + '쪽은 이미 있습니다.\n' +
      '밑줄 ' + dup.notes + '개가 붙어 있어 그대로 두었습니다.\n\n' +
      '<i>다시 넣으려면 앱에서 그 밑줄을 먼저 지우고 찍어주세요.</i>');
  }

  // 밑줄이 없으면 잃을 것이 없다. 나중에 찍은 사진이 대개 더 낫다.
  // 자리는 그대로 두려고 id 와 shot_at 을 유지한 채 내용만 갈아 끼운다.
  if (dup) {
    await env.DB.prepare(
      'UPDATE pages SET sentences = ?, starts_mid = ?, ends_mid = ?,' +
      ' photo_id = COALESCE(?, photo_id), raw = ? WHERE id = ?'
    ).bind(
      JSON.stringify(parsed.sentences),
      parsed.starts_mid_sentence ? 1 : 0,
      parsed.ends_mid_sentence ? 1 : 0,
      photoId, parsed.sentences.join(' '), dup.id
    ).run();

    const dupPrev = dup.prev_id
      ? await env.DB.prepare('SELECT * FROM pages WHERE id = ?').bind(dup.prev_id).first()
      : null;

    return reply(env, chatId, buildReply(env, book, parsed, dupPrev) +
      '\n\n<i>이미 있던 ' + parsed.page_number + '쪽을 이 사진으로 바꿨습니다</i>');
  }

  const prev = await previousPage(env, book, now.toISOString());
  const stitched = shouldStitch(prev, parsed, now);

  const id = newId('p');
  await env.DB.prepare(
    'INSERT INTO pages (id, book, page, shot_at, sentences, starts_mid, ends_mid, prev_id, photo_id, raw)' +
    ' VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).bind(
    id, book, parsed.page_number ?? null, now.toISOString(),
    JSON.stringify(parsed.sentences),
    parsed.starts_mid_sentence ? 1 : 0,
    parsed.ends_mid_sentence ? 1 : 0,
    stitched ? prev.id : null,
    photoId, parsed.sentences.join(' ')
  ).run();

  if (caption) {
    await env.DB.prepare('UPDATE pages SET raw = raw || ? WHERE id = ?')
      .bind('\n' + caption, id).run();
  }

  return reply(env, chatId, buildReply(env, book, parsed, stitched ? prev : null));
}

/**
 * 표지 사진으로 책을 정한다.
 *
 * 알라딘에서 찾으면 그 표지를 쓰고, 못 찾으면 **방금 찍은 사진**을 표지로 쓴다.
 * 어차피 드라이브에 올려 뒀으니 버릴 이유가 없다.
 */
async function onCover(env, chatId, parsed, photoId) {
  const title = parsed.book_title.trim();
  const author = (parsed.book_author || '').trim();

  await setState(env, '현재_책', title);
  const found = await lookupBook(env, title, title, author);

  // 알라딘이 표지를 못 줬으면 내가 찍은 표지로 채운다
  let cover = found && found.cover_url;
  if (!cover && photoId) {
    cover = photoUrl(photoId);
    await saveBook(env, title, {
      title, author: (found && found.author) || author || null,
      publisher: found && found.publisher, isbn13: found && found.isbn13,
      cover_url: cover
    });
  }

  const who = (found && found.author) || author;
  return reply(env, chatId, [
    '📖 <b>' + esc(title) + '</b>' + josaRo(title) + ' 시작합니다.',
    who ? '<i>' + esc(who) + (found && found.publisher ? ' · ' + esc(found.publisher) : '') + '</i>' : '',
    cover ? '' : '<i>표지를 못 찾았습니다</i>',
    '',
    '이제 페이지 사진을 보내주세요.'
  ].filter(Boolean).join('\n'));
}

/**
 * 앞 페이지와 이어지는지 판정한다. v1 에서 검증된 규칙 그대로다.
 * 쪽번호를 둘 다 읽었으면 연속일 때만, 없으면 직전 촬영과 가까울 때만 붙인다.
 * 책을 앞뒤로 오가며 찍어도 엉뚱하게 붙지 않게 하기 위해서다.
 */
function shouldStitch(prev, parsed, now) {
  if (!prev || !prev.ends_mid) return false;
  if (!parsed.starts_mid_sentence) return false;

  if (prev.page && parsed.page_number) {
    return Number(parsed.page_number) === Number(prev.page) + 1;
  }

  const t = Date.parse(prev.shot_at);
  return Number.isFinite(t) && (now.getTime() - t) <= STITCH_WINDOW_MS;
}

function buildReply(env, book, parsed, prev) {
  const lines = [
    '📖 <b>' + esc(book) + '</b>' + (parsed.page_number ? ' ' + parsed.page_number + '쪽' : '') +
    ' · 문장 ' + parsed.sentences.length + '개', ''
  ];
  parsed.sentences.forEach((s, i) => lines.push((i + 1) + '. ' + esc(s)));

  if (prev) {
    lines.push('', '↳ ' + (prev.page ? prev.page + '쪽' : '앞 페이지') + ' 마지막 문장과 이어붙였습니다');
  } else if (parsed.ends_mid_sentence) {
    lines.push('', '↳ 마지막 문장이 다음 페이지로 이어집니다');
  }

  if (env.APP_URL) lines.push('', '<a href="' + env.APP_URL + '">밑줄에서 열기</a>');

  const out = lines.join('\n');
  return out.length > 4000 ? out.slice(0, 3900) + '\n\n… (길어서 줄임)' : out;
}

// ──────────────────────── 드라이브 어댑터 ────────────────────────

/**
 * 사진만 구글 드라이브에 남긴다. Worker 에는 구글 인증이 없으므로
 * "받아서 드라이브에 넣고 링크를 돌려주는" Apps Script 를 하나 남겨 두고 부른다.
 * 자세한 배경은 설계-v2.md 2절.
 */
async function saveToDrive(env, base64, mime, book, when) {
  if (!env.DRIVE_ADAPTER_URL) return null;

  const name = [
    book.replace(/[\\/:*?"<>|]/g, '_'),
    when.toISOString().slice(0, 19).replace(/[:T-]/g, '')
  ].join('_') + '.jpg';

  const res = await fetch(env.DRIVE_ADAPTER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: env.DRIVE_SECRET, name, mime, data: base64 }),
    redirect: 'follow'   // Apps Script 는 302 를 돌려준다. Worker 는 따라갈 수 있다.
  });

  const body = await res.json();
  if (!body.ok) throw new Error('드라이브 어댑터: ' + (body.error || res.status));
  return body.id;
}

// ──────────────────────── Gemini ────────────────────────

const PAGE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    kind: { type: 'STRING',
      description: "책 표지면 'cover', 본문 페이지면 'page', 둘 다 아니면 'other'." },
    book_title: { type: 'STRING', nullable: true,
      description: '표지일 때 책 제목. 부제는 빼고 본 제목만.' },
    book_author: { type: 'STRING', nullable: true,
      description: '표지일 때 지은이. 옮긴이·그림 표기는 빼고 지은이만.' },
    page_number: { type: 'INTEGER', nullable: true,
      description: '페이지에 인쇄된 쪽번호. 없으면 null. 양면이면 오른쪽(나중) 쪽번호.' },
    sentences: { type: 'ARRAY', items: { type: 'STRING' },
      description: '본문을 문장 단위로 쪼갠 배열.' },
    starts_mid_sentence: { type: 'BOOLEAN',
      description: '첫 문장이 앞 페이지에서 이어지는 조각인가.' },
    ends_mid_sentence: { type: 'BOOLEAN',
      description: '마지막 문장이 끝나지 않고 다음 페이지로 이어지는가.' }
  },
  propertyOrdering: ['kind', 'book_title', 'book_author', 'page_number',
                     'sentences', 'starts_mid_sentence', 'ends_mid_sentence'],
  required: ['kind', 'book_title', 'book_author', 'sentences',
             'starts_mid_sentence', 'ends_mid_sentence']
};

const PAGE_PROMPT = [
  '이 이미지는 책을 찍은 사진입니다. JSON으로만 답하세요.',
  '',
  '먼저 무엇을 찍은 것인지 kind 로 판정하세요.',
  "- 'cover' : 책 표지(겉표지·속표지·뒤표지).",
  "- 'page'  : 본문 페이지. 여러 줄의 문단이 이어집니다.",
  "- 'other' : 책 사진이 아니거나 글자를 알아볼 수 없음.",
  '',
  '표지에는 띠지 문구, 추천사, 수상 내역, 저자 사진, 출판사 로고가 함께 인쇄되어',
  '있는 경우가 많습니다. **그런 문구가 아무리 많아도 본문 문단이 아니면 표지입니다.**',
  '큰 글씨의 제목과 지은이 이름이 보이면 거의 확실히 표지입니다.',
  '',
  '표지라면 book_title 과 book_author 를 채우고 sentences 는 빈 배열로 두세요.',
  '- book_title: 가장 크게 인쇄된 본 제목만. 부제·띠지 문구·시리즈명은 빼세요.',
  '  예) 위에 작게 "AI는 생각하지 않는다", 크게 "AI 리터러시" → "AI 리터러시"',
  '- book_author: "이재현 지음" 처럼 적혀 있으면 "이재현" 만 쓰세요.',
  '표지가 아니면 book_title 과 book_author 를 null 로 두세요.',
  '',
  '본문 페이지일 때 규칙:',
  '- 본문만 담으세요. 쪽번호, 각주 번호, 머리말(러닝헤드), 챕터 제목, 출판사 정보는 문장에서 빼세요.',
  '- 본문을 문장 단위로 쪼개 sentences 배열에 넣으세요. 대화문의 따옴표는 그대로 둡니다.',
  '- 문단이 바뀌어도 배열 원소를 나누기만 하고 빈 원소는 넣지 마세요.',
  '- 페이지가 문장 도중에 끝나면, 그 조각을 있는 그대로 마지막 원소로 두고',
  '  ends_mid_sentence 를 true 로 하세요. 임의로 문장을 완성하지 마세요.',
  '- 첫 문장이 앞 페이지에서 이어지는 조각이면 starts_mid_sentence 를 true 로 하세요.',
  '- 펼친 양면이면 왼쪽 페이지를 먼저, 오른쪽 페이지를 나중에 읽으세요.',
  '- 글자를 알아볼 수 없으면 지어내지 말고 그 자리에 ▯ 를 쓰세요.',
  '- 쪽번호를 찾을 수 없으면 page_number 를 null 로 두세요.',
  '- 본문이 아니면 sentences 를 빈 배열로 두세요.'
].join('\n');

async function parsePage(env, base64, mime) {
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model +
              ':generateContent?key=' + encodeURIComponent(env.GEMINI_API_KEY);

  const payload = {
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: mime, data: base64 } },
      { text: PAGE_PROMPT }
    ] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: PAGE_SCHEMA
    }
  };

  // 과부하(503)는 흔하고 대개 몇 초면 풀린다. 다만 429 는 재시도하지 않는다 —
  // 하루 한도를 넘긴 것이라면 다시 불러봤자 남은 한도만 더 먹는다.
  const waits = [2000, 5000, 12000];
  let res;
  for (let i = 0; i <= waits.length; i++) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.status < 500) break;
    if (i < waits.length) await sleep(waits[i]);
  }

  const raw = await res.text();

  if (res.status === 429) {
    const m = raw.match(/limit:\s*(\d+)/);
    throw new Error('QUOTA:' + (m ? m[1] : '?') + ':' + model);
  }
  if (!res.ok) throw new Error('Gemini 호출 실패 (HTTP ' + res.status + '): ' + raw.slice(0, 400));

  const body = JSON.parse(raw);
  const cand = (body.candidates && body.candidates[0]) || {};

  // 이미지가 실렸는지 확인하는 가장 확실한 수단. IMAGE 토큰이 없으면 안 간 것이다.
  const usage = body.usageMetadata || {};
  console.log('Gemini usage: prompt=' + usage.promptTokenCount +
              ' / ' + JSON.stringify(usage.promptTokensDetails || []));

  // Gemini 3 계열은 응답을 여러 조각으로 나눠 보내고, thought 조각은 결과가 아니다
  const text = (((cand.content || {}).parts) || [])
    .filter((p) => p && typeof p.text === 'string' && !p.thought)
    .map((p) => p.text).join('');

  if (!text) {
    throw new Error('Gemini 응답이 비었습니다. finishReason=' + (cand.finishReason || '?'));
  }

  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('Gemini가 JSON이 아닌 답을 줬습니다: ' + text.slice(0, 300)); }

  parsed.sentences = (parsed.sentences || []).map((s) => String(s).trim()).filter(Boolean);

  // 표지는 문장이 없는 게 정상이라 경고하지 않는다
  const looksLikeCover = String(parsed.kind || '').toLowerCase() === 'cover' ||
                         !!(parsed.book_title || '').trim();
  if (!parsed.sentences.length && !looksLikeCover) {
    console.warn('문장 0개. finishReason=' + (cand.finishReason || '?') + ' / ' + text.slice(0, 600));
  }
  return parsed;
}

// ════════════════════════════ 시트 → D1 이전 ════════════════════════════

/** book-bot 의 `이전_D1로_보내기` 가 부른다. 한 번 쓰고 잊는 창구다. */
async function adminImport(req, env) {
  // 시크릿을 지우면 env.ADMIN_SECRET 이 undefined 가 된다. 그때 빈 본문을 보내면
  // undefined === undefined 로 통과해버리므로, 설정 여부부터 확인한다.
  // 이전이 끝난 뒤 시크릿을 지우는 것이 곧 이 창구를 영구히 닫는 방법이다.
  if (!env.ADMIN_SECRET) return json({ error: 'disabled' }, 404);

  const body = await req.json();
  if (body.secret !== env.ADMIN_SECRET) return json({ error: 'unauthorized' }, 401);

  const stmts = [];
  for (const p of body.pages || []) {
    stmts.push(env.DB.prepare(
      'INSERT OR REPLACE INTO pages (id, book, page, shot_at, sentences, starts_mid, ends_mid, prev_id, photo_id, raw)' +
      ' VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).bind(p.id, p.book, p.page ?? null, p.shot_at, JSON.stringify(p.sentences || []),
           p.starts_mid ? 1 : 0, p.ends_mid ? 1 : 0, p.prev_id || null,
           p.photo_id || null, (p.sentences || []).join(' ')));
  }
  for (const n of body.notes || []) {
    stmts.push(env.DB.prepare(
      'INSERT OR REPLACE INTO notes (id, page_id, book, page, idx, text, memo, saved_at)' +
      ' VALUES (?,?,?,?,?,?,?,?)'
    ).bind(n.id, n.page_id, n.book, n.page ?? null, n.idx, n.text, null, n.saved_at));
  }

  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, pages: (body.pages || []).length, notes: (body.notes || []).length });
}

// ════════════════════════════ 잡다한 것 ════════════════════════════

function newId(prefix) {
  const d = new Date().toISOString().slice(0, 19).replace(/[:T-]/g, '');
  return prefix + '_' + d + '_' + Math.random().toString(36).slice(2, 6);
}

function safeParse(v) {
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}

/** btoa 는 한 번에 넘길 수 있는 길이가 제한적이라 잘라서 넣는다 */
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
