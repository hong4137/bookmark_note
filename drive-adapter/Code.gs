/**
 * 드라이브 어댑터 — 사진을 받아 내 드라이브에 넣고 링크를 돌려준다.
 *
 * Worker 에는 구글 인증이 없어서 드라이브에 직접 쓸 수 없다. 인증을 넣으려면
 * OAuth 클라이언트·동의 화면·도메인 심사를 다시 거쳐야 하므로, 그 일만 하는
 * 얇은 조각으로 남겨 둔다. 파싱·판정·저장은 전부 Worker 가 한다.
 *
 * 이 스크립트가 하는 일은 이것뿐이다:
 *   1. 암호가 맞는지 확인
 *   2. base64 사진을 독서노트/원본사진 폴더에 저장
 *   3. 링크가 있는 사람은 볼 수 있게 공유 설정
 *   4. 파일 id 를 돌려줌
 *
 * 배포: 웹 앱 / 실행 계정 = 나 / 액세스 = 모든 사용자
 * (Worker 가 로그인 없이 불러야 한다. 대신 암호로 막는다)
 */

const ROOT_FOLDER = '독서노트';
const PHOTO_FOLDER = '원본사진';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    if (body.secret !== scriptProp_('DRIVE_SECRET')) {
      return out_({ ok: false, error: 'unauthorized' });
    }
    if (!body.data) {
      return out_({ ok: false, error: 'no data' });
    }

    const blob = Utilities.newBlob(
      Utilities.base64Decode(body.data),
      body.mime || 'image/jpeg',
      body.name || ('page_' + Date.now() + '.jpg')
    );

    const file = photoFolder_().createFile(blob);

    // 브라우저가 바로 띄울 수 있어야 한다. 주소를 아는 사람은 볼 수 있다는 뜻이다.
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    return out_({ ok: true, id: file.getId() });
  } catch (err) {
    console.error(err.stack || String(err));
    return out_({ ok: false, error: String(err.message || err) });
  }
}

/** 배포가 살아있는지 확인용. 브라우저로 열어보면 된다. */
function doGet() {
  return out_({ ok: true, adapter: '드라이브 어댑터가 살아 있습니다.' });
}

function photoFolder_() {
  const root = childFolder_(DriveApp.getRootFolder(), ROOT_FOLDER);
  return childFolder_(root, PHOTO_FOLDER);
}

function childFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function scriptProp_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('스크립트 속성이 비어 있습니다: ' + key);
  return v;
}

// ──────────────────────── 설치 ────────────────────────

/**
 * 1단계 — Worker 와 나눠 가질 암호를 정합니다.
 * 실행하면 만들어진 암호가 로그에 뜹니다. 그 값을 Worker 에
 *   npx wrangler secret put DRIVE_SECRET
 * 으로 넣으세요.
 */
function step1_암호_만들기() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('DRIVE_SECRET');

  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('DRIVE_SECRET', secret);
  }

  console.log('DRIVE_SECRET = ' + secret);
  console.log('\n다음: 배포 → 새 배포 → 웹 앱 (실행: 나 / 액세스: 모든 사용자)');
  console.log('그 /exec 주소를 wrangler.toml 의 DRIVE_ADAPTER_URL 에 넣으세요.');
}

/** 2단계 — 배포한 뒤, 저장이 실제로 되는지 확인합니다. */
function step2_저장_확인() {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const res = doPost({ postData: { contents: JSON.stringify({
    secret: scriptProp_('DRIVE_SECRET'),
    name: '어댑터_설치확인.png',
    mime: 'image/png',
    data: png
  }) } });

  const body = JSON.parse(res.getContent());
  if (!body.ok) throw new Error('실패: ' + body.error);

  console.log('저장 성공. 파일 id = ' + body.id);
  console.log('브라우저에서 확인: https://drive.google.com/thumbnail?id=' + body.id);
  console.log('\n독서노트/원본사진 폴더에서 "어댑터_설치확인.png" 를 지우세요.');
}
