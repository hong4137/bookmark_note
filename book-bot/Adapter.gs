/**
 * 드라이브 어댑터 — Worker 가 보낸 사진을 드라이브에 넣고 파일 id 를 돌려준다.
 *
 * 왜 이 조각만 Apps Script 에 남나:
 * 사진을 구글 드라이브에 보관하기로 했는데, Worker 에는 구글 인증이 없다.
 * 인증을 넣으려면 OAuth 클라이언트·동의 화면·도메인 심사를 다시 거쳐야 한다.
 * 그래서 "받아서 드라이브에 넣고 링크를 돌려주는" 일만 여기 남긴다.
 *
 * 이 파일은 v1 봇과 같은 프로젝트에 얹는다. 이미 드라이브 권한도,
 * 사진 폴더 id(PHOTO_FOLDER_ID)도 여기 있기 때문이다.
 * v1 봇을 끈 뒤에도 이 프로젝트는 이 역할로 계속 남는다.
 *
 * 배포: 웹 앱 / 실행 계정 = 나 / 액세스 = 모든 사용자
 * (Worker 가 로그인 없이 불러야 한다. 대신 암호로 막는다)
 */

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    if (body.secret !== prop_('DRIVE_SECRET')) return adapterOut_({ ok: false, error: 'unauthorized' });
    if (!body.data) return adapterOut_({ ok: false, error: 'no data' });

    const blob = Utilities.newBlob(
      Utilities.base64Decode(body.data),
      body.mime || 'image/jpeg',
      body.name || ('page_' + Date.now() + '.jpg')
    );

    const file = DriveApp.getFolderById(prop_('PHOTO_FOLDER_ID')).createFile(blob);

    // 브라우저가 바로 띄울 수 있어야 한다. 주소를 아는 사람은 볼 수 있다는 뜻이다.
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    return adapterOut_({ ok: true, id: file.getId() });
  } catch (err) {
    console.error(err.stack || String(err));
    return adapterOut_({ ok: false, error: String(err.message || err) });
  }
}

/** 배포가 살아있는지 확인용. 브라우저로 열어보면 된다. */
function doGet() {
  return adapterOut_({ ok: true, adapter: '드라이브 어댑터가 살아 있습니다.' });
}

function adapterOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


/**
 * v2-1단계 — Worker 와 나눠 가질 암호를 만듭니다.
 * 로그에 뜬 값을 `npx wrangler secret put DRIVE_SECRET` 으로 넣으세요.
 */
function v2_어댑터_암호만들기() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('DRIVE_SECRET');

  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('DRIVE_SECRET', secret);
  }

  console.log('DRIVE_SECRET = ' + secret);
  console.log('사진 폴더: ' + props.getProperty('PHOTO_FOLDER_ID'));
  console.log('\n다음: 배포 → 새 배포 → 웹 앱 (실행: 나 / 액세스: 모든 사용자)');
  console.log('그 /exec 주소를 wrangler.toml 의 DRIVE_ADAPTER_URL 에 넣으세요.');
}


/** v2-2단계 — 배포한 뒤, 저장이 실제로 되는지 확인합니다. */
function v2_어댑터_저장확인() {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const res = doPost({ postData: { contents: JSON.stringify({
    secret: prop_('DRIVE_SECRET'),
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
