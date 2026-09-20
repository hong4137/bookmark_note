# 밑줄 — 책 페이지를 찍으면 문장이 되는 노트

텔레그램 봇에 책 페이지를 찍어 보내면 Gemini가 문장 단위로 쪼개 저장하고,
앱에서 마음에 드는 문장만 눌러 밑줄을 긋는다.

> 왜 이렇게 만들었는지는 **[설계-v2.md](설계-v2.md)**.
> v1(Apps Script)의 데이터 모델·이어붙이기 규칙은 [설계.md](설계.md)에 있고 v2도 그대로 쓴다.

```
텔레그램 ──웹훅──▶ Cloudflare Worker ──▶ D1        페이지 / 밑줄
                     │                └▶ Gemini    문장 파싱
                     └▶ Apps Script 어댑터 ──▶ 구글 드라이브 (원본 사진)

   앱 ──▶ Worker (정적 파일 + API) ──▶ D1
```

```
book-notes/
├── 설계.md / 설계-v2.md
├── worker/              ← 본체 (Worker + D1 + 앱 화면)
│   ├── wrangler.toml
│   ├── schema.sql
│   ├── src/index.js
│   ├── public/          앱 화면 (index.html, app.js)
│   └── dev-preview.mjs  D1 없이 화면만 보는 개발용 스텁
└── book-bot/            ← 기존 Apps Script 프로젝트
    ├── Code.gs          v1 봇 (이전 후 트리거만 끈다)
    ├── Setup.gs         설치 + 시트→D1 이전
    └── Adapter.gs       사진을 드라이브에 넣는 조각 ← v2 에서 계속 쓴다
```

## 새로 만들 것 / 그대로 쓸 것

| | |
|---|---|
| **그대로 쓴다** | 텔레그램 봇 (같은 토큰), Gemini API 키, Apps Script 프로젝트, 드라이브 폴더, 시트 |
| **새로 만든다** | Cloudflare Worker, D1 |

봇을 새로 팔 필요도, Apps Script 프로젝트를 새로 만들 필요도 없다.
기존 프로젝트에는 이미 드라이브 권한과 사진 폴더 id 가 있어서, 어댑터 파일 하나만 얹으면 된다.

---

## 준비물

| | |
|---|---|
| 텔레그램 봇 토큰 | **기존 봇 그대로.** 새로 만들지 않는다 |
| Gemini API 키 | **기존 키 그대로** |
| Cloudflare 계정 | 무료. `npx wrangler login` |

봇 토큰과 Gemini 키를 잊었으면 기존 Apps Script 에서
**⚙️ 프로젝트 설정 → 스크립트 속성**을 열면 전체 값이 그대로 있다.
(`상태확인` 은 앞 여섯 자만 찍으므로 그것으로는 알 수 없다)

---

## 설치

### 1. 기존 Apps Script 에 어댑터 얹기

새 프로젝트를 만들지 않는다. **기존 `book-bot` 프로젝트**에 파일 하나를 추가한다.
드라이브 권한도 사진 폴더 id 도 이미 거기 있다.

1. 기존 프로젝트 열기 → **＋ → 스크립트** → 이름 `Adapter`
2. `book-bot/Adapter.gs` 내용 붙여넣기
3. `appsscript.json` 도 이 저장소 것으로 교체 (웹 앱 배포 설정이 들어간다)
4. **`v2_어댑터_암호만들기`** 실행 → 로그의 `DRIVE_SECRET` 복사
5. 배포 → 새 배포 → **웹 앱** / 실행: **나** / 액세스: **모든 사용자**
   (Worker가 로그인 없이 불러야 한다. 대신 암호로 막는다)
6. **`v2_어댑터_저장확인`** 실행 → 드라이브에 파일이 생기면 성공. 확인 후 지운다

`/exec` 주소를 복사해 둔다.

### 2. D1 만들기

```bash
cd book-notes/worker
npx wrangler d1 create booknote
```

출력된 `database_id` 를 `wrangler.toml` 에 넣고, 스키마를 올린다.

```bash
npx wrangler d1 execute booknote --remote --file=schema.sql
```

### 3. wrangler.toml 채우기

```toml
[vars]
ALLOWED_CHATS     = "내 텔레그램 챗 ID"
DRIVE_ADAPTER_URL = "https://script.google.com/.../exec"
APP_URL           = ""   # 4단계에서 배포 주소가 나오면 채운다
```

> 챗 ID를 모르면 일단 비워두고 배포한 뒤, 봇에 아무 말이나 보내고
> `npx wrangler tail` 로그의 `미승인 접근: chat_id=...` 를 보면 된다.

### 4. 시크릿 넣고 배포

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_SECRET     # 아무 긴 문자열. 5단계에서 같은 값을 쓴다
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put DRIVE_SECRET        # 1단계에서 받은 값
npx wrangler secret put ADMIN_SECRET        # 아무 긴 문자열. 6단계에서 쓴다
npx wrangler secret put ALADIN_TTB_KEY      # (선택) 책 표지. 없으면 표지만 안 나온다
npx wrangler deploy
```

배포 주소(`https://bookmark-note.<계정>.workers.dev`)를 `wrangler.toml` 의 `APP_URL` 에 넣고 다시 `deploy`.

### 5. 기존 봇을 Worker 로 돌리기

⚠️ **먼저 v1 폴링을 끈다.** 기존 Apps Script 에서 **`트리거_제거`** 실행.
텔레그램은 봇 하나에 웹훅과 `getUpdates` 를 동시에 허용하지 않는다.
안 끄면 둘이 메시지를 뺏는다.

그 다음 같은 봇의 수신처만 Worker 로 바꾼다.

```powershell
# PowerShell 에서는 curl 이 Invoke-WebRequest 별칭이고 < > 가 리디렉션 기호라
# 꺾쇠 자리표시자를 그대로 쓰면 명령이 깨진다. 변수로 먼저 담는다.
$token  = "기존 봇 토큰"
$worker = "https://bookmark-note.○○○.workers.dev"
$secret = "TELEGRAM_SECRET"

Invoke-RestMethod "https://api.telegram.org/bot$token/setWebhook?url=$worker/tg&secret_token=$secret"
```

`{"ok":true}` 가 나오면 된다. 봇에 `/start` 를 보내 답이 오면 연결 성공.
**봇 주소도 대화 내용도 그대로다.** 뒤에서 일하는 쪽만 바뀐 것이다.

### 6. v1 데이터 옮기기 (v1을 쓰고 있었다면)

`book-bot` 프로젝트 `Setup.gs` 의 `WORKER_URL` 과 `ADMIN_SECRET` 을 채우고
**`v2_D1로_이전`** 실행. 여러 번 실행해도 안전하다(같은 id는 덮어쓴다).

### 7. 앱 열기

봇에 **`/앱`** → 받은 링크를 폰에서 열고 **홈 화면에 추가**.
링크에 접근 권한이 들어 있고, 한 번 열면 그 기기에 기억된다.

---

## 쓰는 법

| 입력 | 결과 |
|---|---|
| `/책 데미안` | 읽는 책 설정. 이후 사진은 전부 이 책으로 |
| `/책` | 지금 무슨 책인지 |
| `/앱` | 앱 링크 발급 |
| `/표지 제목` | 표지를 잘못 찾았을 때 다시 찾기 |
| 📷 사진 | 파싱 → 저장 → 결과 답장 |

앱에서:

| 동작 | 결과 |
|---|---|
| 문장 **탭** | 밑줄 ↔ 지우기. 그대로 밑줄 목록에 쌓인다 |
| **✎** | 파싱이 틀렸을 때 고친다. 이미 그은 밑줄도 같이 고쳐진다 |
| **원본** | 그 페이지 사진을 띄운다 |
| **끊기 / 이어붙이기** | 페이지 넘김 판정이 틀렸을 때 바로잡는다 |

앞 페이지에서 이어진 문장은 앞 조각이 흐리게 붙어 보이고,
밑줄을 그으면 **합쳐진 전체 문장**이 저장된다.

## 잘 찍는 요령

- **펼친 양면으로** 찍으면 문장이 페이지에서 잘리지 않아 제일 깔끔하다
- 페이지가 평평하게 펴지도록. 휘어진 부분에서 행이 겹친다
- 봇 답장을 그 자리에서 눈으로 확인하는 것이 1차 검증이다
- 읽지 못한 글자는 `▯` 로 표시된다. 지어내지 않는다

---

## 고치고 확인하기

```bash
# 화면만 (D1·Gemini 없이, 가짜 데이터)
node worker/dev-preview.mjs          # http://localhost:8788

# 진짜로 (로컬 D1)
cd worker
npx wrangler d1 execute booknote --local --file=schema.sql
npx wrangler dev --local             # http://localhost:8787
```

로컬에서 앱을 열려면 토큰을 하나 넣어두고 `?t=` 로 붙인다.

```bash
npx wrangler d1 execute booknote --local \
  --command "INSERT INTO app_tokens VALUES ('devtoken','now')"
# http://localhost:8787/?t=devtoken
```

## 문제 해결

| 증상 | 확인 |
|---|---|
| 봇이 무응답 | `npx wrangler tail` 로 실시간 로그. 웹훅은 `getWebhookInfo` 로 |
| "지정된 사용자만" | `ALLOWED_CHATS` 에 내 챗 ID가 있는지 |
| 앱이 "권한 없음" | 봇에 `/앱` 으로 새 링크 |
| 사진이 안 뜸 | 어댑터 `/exec` 를 브라우저로 열어 살아있는지. `DRIVE_SECRET` 양쪽 일치 |
| Gemini 404 | 모델이 은퇴한 것. `src/index.js` 의 `GEMINI_MODEL` 교체 |
| Gemini 503 | 과부하. 2·5·12초 간격으로 세 번 다시 시도한다 |
| 글자를 못 읽음 | 사진 다시. 위 "잘 찍는 요령" |
