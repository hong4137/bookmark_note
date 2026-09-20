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
 * 변수 (wrangler.toml [vars]):
 *   ALLOWED_CHATS        쉼표로 구분한 텔레그램 챗 ID
 *   DRIVE_ADAPTER_URL    Apps Script 어댑터의 /exec 주소
 */

const GEMINI_MODEL = 'gemini-3.6-flash';

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
  const [pages, notes] = await Promise.all([
    env.DB.prepare('SELECT * FROM pages ORDER BY shot_at').all(),
    env.DB.prepare('SELECT * FROM notes ORDER BY saved_at').all()
  ]);

  return {
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
  if (req.headers.get('x-telegram-bot-api-secret-token') !== env.TELEGRAM_SECRET) {
    return new Response('no', { status: 401 });
  }

  // 파싱은 수십 초가 걸린다. 텔레그램에는 먼저 200 을 돌려주고 뒤에서 일한다.
  return req.json().then((update) => {
    ctx.waitUntil(handleUpdate(update, env).catch((err) => console.error(err.stack || String(err))));
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

  const text = (msg.text || '').trim();

  if (text.startsWith('/책')) return cmdBook(env, chatId, text.slice(2).trim());
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

async function cmdBook(env, chatId, name) {
  if (!name) {
    const now = await getState(env, '현재_책');
    return reply(env, chatId, now
      ? '지금 읽는 책: <b>' + esc(now) + '</b>'
      : '아직 책을 정하지 않았습니다.\n<b>/책 데미안</b> 처럼 보내주세요.');
  }
  await setState(env, '현재_책', name);
  return reply(env, chatId, '📖 <b>' + esc(name) + '</b>' + josaRo(name) +
    ' 설정했습니다.\n이제 페이지 사진을 보내주세요.');
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

const cmdHelp = (env, chatId) => reply(env, chatId, [
  '🔖 <b>밑줄</b>',
  '',
  '<b>/책 데미안</b> — 읽는 책 정하기',
  '<b>/책</b> — 지금 무슨 책인지',
  '<b>/앱</b> — 밑줄 앱 열기',
  '',
  '책을 정한 뒤 페이지 사진을 보내면 문장 단위로 저장합니다.',
  '펼친 양면으로 찍으면 문장이 잘리지 않아 더 깔끔합니다.'
].join('\n'));

// ──────────────────────── 사진 처리 ────────────────────────

async function onPhoto(env, chatId, fileId, caption) {
  const book = await getState(env, '현재_책');
  if (!book) {
    return reply(env, chatId, '먼저 책을 정해주세요.\n<b>/책 데미안</b> 처럼 보내시면 됩니다.');
  }

  await tg(env, 'sendChatAction', { chat_id: chatId, action: 'typing' });

  let bytes, mime;
  try {
    const got = await tg(env, 'getFile', { file_id: fileId });
    const res = await fetch('https://api.telegram.org/file/bot' +
      env.TELEGRAM_BOT_TOKEN + '/' + got.result.file_path);
    if (!res.ok) throw new Error('사진 다운로드 실패 (HTTP ' + res.status + ')');
    bytes = await res.arrayBuffer();
    mime = res.headers.get('content-type') || 'image/jpeg';
  } catch (err) {
    return reply(env, chatId, '⚠️ 사진을 가져오지 못했습니다.\n\n<code>' + esc(String(err.message)) + '</code>');
  }

  const now = new Date();
  const base64 = toBase64(bytes);

  // 파싱보다 먼저 저장한다. 파싱이 실패해도 원본은 남아야 한다.
  let photoId = null;
  try {
    photoId = await saveToDrive(env, base64, mime, book, now);
  } catch (err) {
    console.error('드라이브 저장 실패: ' + err);   // 저장 실패해도 파싱은 계속한다
  }

  let parsed;
  try {
    parsed = await parsePage(env, base64, mime);
  } catch (err) {
    console.error(err.stack || String(err));
    return reply(env, chatId, '⚠️ 처리 중 문제가 생겼습니다.\n\n<code>' +
      esc(String(err.message || err)).slice(0, 700) + '</code>');
  }

  if (!parsed.sentences.length) {
    return reply(env, chatId,
      '글자를 읽어내지 못했습니다. 밝은 곳에서 페이지가 평평하게 펴지도록 다시 찍어주세요. 📷');
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
    lines.push('', '⟩ ' + (prev.page ? prev.page + '쪽' : '앞 페이지') + ' 마지막 문장과 이어붙였습니다');
  } else if (parsed.ends_mid_sentence) {
    lines.push('', '⟩ 마지막 문장이 다음 페이지로 이어집니다');
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
    page_number: { type: 'INTEGER', nullable: true,
      description: '페이지에 인쇄된 쪽번호. 없으면 null. 양면이면 오른쪽(나중) 쪽번호.' },
    sentences: { type: 'ARRAY', items: { type: 'STRING' },
      description: '본문을 문장 단위로 쪼갠 배열.' },
    starts_mid_sentence: { type: 'BOOLEAN',
      description: '첫 문장이 앞 페이지에서 이어지는 조각인가.' },
    ends_mid_sentence: { type: 'BOOLEAN',
      description: '마지막 문장이 끝나지 않고 다음 페이지로 이어지는가.' }
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
  '- 펼친 양면이면 왼쪽 페이지를 먼저, 오른쪽 페이지를 나중에 읽으세요.',
  '- 글자를 알아볼 수 없으면 지어내지 말고 그 자리에 ▯ 를 쓰세요.',
  '- 쪽번호를 찾을 수 없으면 page_number 를 null 로 두세요.',
  '- 책 페이지가 아니면 sentences 를 빈 배열로 두세요.'
].join('\n');

async function parsePage(env, base64, mime) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL +
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

  // 과부하(503)는 흔하고 대개 몇 초면 풀린다
  const waits = [2000, 5000, 12000];
  let res;
  for (let i = 0; i <= waits.length; i++) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.status !== 429 && res.status < 500) break;
    if (i < waits.length) await sleep(waits[i]);
  }

  const raw = await res.text();
  if (!res.ok) throw new Error('Gemini 호출 실패 (HTTP ' + res.status + '): ' + raw.slice(0, 400));

  const body = JSON.parse(raw);
  const cand = (body.candidates && body.candidates[0]) || {};

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

  if (!parsed.sentences.length) {
    console.warn('문장 0개. finishReason=' + (cand.finishReason || '?') + ' / ' + text.slice(0, 600));
  }
  return parsed;
}

// ════════════════════════════ 시트 → D1 이전 ════════════════════════════

/** book-bot 의 `이전_D1로_보내기` 가 부른다. 한 번 쓰고 잊는 창구다. */
async function adminImport(req, env) {
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
