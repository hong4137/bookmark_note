-- 독서 노트 v2 — D1 스키마
-- 시트 컬럼을 거의 그대로 옮겼다. 자세한 배경은 ../설계-v2.md 3절.

CREATE TABLE IF NOT EXISTS pages (
  id         TEXT PRIMARY KEY,
  book       TEXT NOT NULL,
  page       INTEGER,
  shot_at    TEXT NOT NULL,
  sentences  TEXT NOT NULL,
  starts_mid INTEGER NOT NULL DEFAULT 0,
  ends_mid   INTEGER NOT NULL DEFAULT 0,
  prev_id    TEXT,
  photo_id   TEXT,
  raw        TEXT
);
CREATE INDEX IF NOT EXISTS idx_pages_book_shot ON pages(book, shot_at);

CREATE TABLE IF NOT EXISTS notes (
  id        TEXT PRIMARY KEY,
  page_id   TEXT NOT NULL,
  book      TEXT NOT NULL,
  page      INTEGER,
  idx       INTEGER NOT NULL,
  text      TEXT NOT NULL,
  memo      TEXT,
  saved_at  TEXT NOT NULL,
  UNIQUE(page_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_notes_book ON notes(book, saved_at);

-- 현재 읽는 책, 순번 카운터 등
CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT);

-- 앱 접근 토큰. 봇이 /앱 명령으로 발급한다.
CREATE TABLE IF NOT EXISTS app_tokens (token TEXT PRIMARY KEY, created_at TEXT);
