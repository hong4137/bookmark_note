/**
 * 화면만 빠르게 확인하는 개발용 서버.
 *
 * D1 · Gemini · 텔레그램 없이 public/ 을 그대로 띄우고 API 는 가짜로 답한다.
 * 배포와는 무관하다. 실제 동작은 `npx wrangler dev` 로 확인한다.
 *
 *   node dev-preview.mjs      → http://localhost:8788
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const PORT = 8788;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const PHOTO = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="620" height="860">' +
  '<rect width="620" height="860" fill="#efe9dc"/>' +
  '<text x="310" y="430" text-anchor="middle" font-size="26" fill="#8b8275">page photo</text></svg>');

const db = {
  pages: [
    {
      id: 'p1', book: 'AI 리터러시', page: 48, shot_at: '2026-09-19T01:28:00+09:00',
      starts_mid: 0, ends_mid: 0, prev_id: null, photo_url: PHOTO,
      sentences: [
        '이 차이는 작아 보이지만 반복되면 전혀 다른 사람을 만들어낸다.',
        '도구는 어떻게 쓰느냐에 따라 사람을 키우기도 하고 사람을 갉아먹기도 하기 때문이다.',
        '매번 AI에게 먼저 물어보는 사람은 점점 스스로 생각의 근육을 키울 기회를 잃는다.',
        '먼저 생각하고 나서 확인할 때 AI를 쓰는 사람은 AI를 쓸수록 자신의 감각을 갈고닦을 수 있다.',
        '그러니 이 시대에 필요한 기술 중 하나는 무엇을 내 손에 쥐어야 하고 무엇을 AI에게 맡겨야 하며, AI에 일을 믿고 맡기려면 어떻게 해야 할지 아는 것이다.'
      ]
    },
    {
      id: 'p0', book: 'AI 리터러시', page: 58, shot_at: '2026-09-19T01:29:00+09:00',
      starts_mid: 0, ends_mid: 1, prev_id: null, photo_url: PHOTO,
      sentences: [
        '와이젠바움은 일라이자가 사람들에게 불러일으킨 반응을 보고 도리어 겁을 먹었다.',
        '그는 이후 평생에 걸쳐, 사람을 대하는 일'
      ]
    },
    {
      id: 'p2', book: 'AI 리터러시', page: 59, shot_at: '2026-09-19T01:30:00+09:00',
      starts_mid: 1, ends_mid: 0, prev_id: 'p0', photo_url: PHOTO,
      sentences: [
        '처럼 인간의 공감과 책임이 필요한 영역에 AI를 들이는 것에 강하게 반대했다.',
        '기계는 결코 누군가를 진심으로 이해하거나 아낄 수 없으며, 그런 척하도록 만든 기계를 그 자리에 놓는 것은 사람을 속이는 일이라고 그는 보았다.',
        '당시 학계 일부는 기술 공포증이라 비판했지만 그는 끝까지 입장을 굽히지 않았다.',
        '당대에 AI를 가장 깊이 연구하던 사람이 AI에 가장 회의적인 목소리를 낸 것은 아이러니가 아니라 필연이었다.',
        '이 사건을 계기로 사람들이 기계에 쉽게 감정을 이입하고 인간적 특성을 투영하는 현상에 일라이자 효과라는 이름이 붙었다.',
        '반면 오늘의 AI는 문맥에 맞는 어휘 선택, 정중한 어조, 논리적인 문장 구조를 두루 갖추어 사용자의 의식 속에 지적인 권위까지 두르고 자리를 잡는다.'
      ]
    },
    {
      id: 'p3', book: '데미안', page: 121, shot_at: '2026-09-18T22:10:00+09:00',
      starts_mid: 0, ends_mid: 0, prev_id: null, photo_url: PHOTO,
      sentences: [
        '새는 알에서 나오려고 투쟁한다.',
        '알은 세계다.',
        '태어나려는 자는 하나의 세계를 깨뜨려야 한다.'
      ]
    }
  ],
  notes: [
    { id: 'n1', page_id: 'p1', book: 'AI 리터러시', page: 48, idx: 1,
      text: '도구는 어떻게 쓰느냐에 따라 사람을 키우기도 하고 사람을 갉아먹기도 하기 때문이다.',
      saved_at: '2026-09-19T01:31:00+09:00' },
    { id: 'n2', page_id: 'p2', book: 'AI 리터러시', page: 59, idx: 1,
      text: '기계는 결코 누군가를 진심으로 이해하거나 아낄 수 없으며, 그런 척하도록 만든 기계를 그 자리에 놓는 것은 사람을 속이는 일이라고 그는 보았다.',
      saved_at: '2026-09-19T01:32:00+09:00' },
    { id: 'n3', page_id: 'p3', book: '데미안', page: 121, idx: 0,
      text: '새는 알에서 나오려고 투쟁한다.',
      saved_at: '2026-09-18T22:11:00+09:00' }
  ]
};

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((ok) => {
  let s = '';
  req.on('data', (c) => (s += c));
  req.on('end', () => ok(s ? JSON.parse(s) : {}));
});

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  if (path.startsWith('/api/')) {
    const body = req.method === 'POST' ? await readBody(req) : {};

    if (path === '/api/bootstrap') return json(res, db);

    if (path === '/api/notes/toggle') {
      const i = db.notes.findIndex((n) => n.page_id === body.page_id && n.idx === body.idx);
      if (i >= 0) { db.notes.splice(i, 1); return json(res, { on: false }); }
      const page = db.pages.find((p) => p.id === body.page_id);
      const note = { id: 'n' + Date.now(), page_id: body.page_id, book: page.book,
                     page: page.page, idx: body.idx, text: body.text,
                     saved_at: new Date().toISOString() };
      db.notes.push(note);
      return json(res, { on: true, note });
    }

    const m = path.match(/^\/api\/pages\/([^/]+)\/(sentence|stitch)$/);
    if (m) {
      const page = db.pages.find((p) => p.id === m[1]);
      if (!page) return json(res, { error: 'not found' }, 404);

      if (m[2] === 'sentence') {
        page.sentences[body.idx] = body.text;
        const n = db.notes.find((x) => x.page_id === page.id && x.idx === body.idx);
        if (n) n.text = body.text;
        return json(res, { text: body.text });
      }

      if (!body.on) { page.prev_id = null; return json(res, { prev_id: null }); }
      const prev = db.pages
        .filter((p) => p.book === page.book && p.shot_at < page.shot_at)
        .sort((a, b) => (a.shot_at < b.shot_at ? 1 : -1))[0];
      if (!prev) return json(res, { error: '이어붙일 앞 페이지가 없습니다.' }, 400);
      page.prev_id = prev.id;
      return json(res, { prev_id: prev.id });
    }

    return json(res, { error: 'not found' }, 404);
  }

  const file = path === '/' ? '/index.html' : path;
  try {
    const buf = await readFile(join(ROOT, file));
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store'   // 고치자마자 반영되어야 한다
    });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(PORT, () => console.log('http://localhost:' + PORT + '/?t=dev'));
